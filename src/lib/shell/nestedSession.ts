/**
 * Recognizing when the terminal has stepped into *another environment*.
 *
 * The Shell tab straddles two worlds. `run_command` / `shell_input` type into
 * the PTY, so they act on whatever the terminal is currently in. The file tools
 * (fs_read_text, fs_write_text, fs_edit_text, code_grep, code_glob) go through
 * Tauri to the local filesystem, so they always act on the machine Haruspex
 * runs on. Those are the same place right up until the user runs `ssh`,
 * `docker exec -it`, `distrobox enter` — and from then on they are not.
 *
 * Nothing in the captured output announces the split, and the tracked cwd goes
 * stale too: OSC 7 comes from the *local* shell's prompt hook, which stops
 * firing the moment a remote shell owns the terminal. So the agent asked to
 * "fix that config" writes a local file, reports success, and the user is
 * looking at an unchanged file on the server.
 *
 * This module classifies the in-flight command line so the agent can be told
 * which side it is on. Deliberately narrow: only commands that unambiguously
 * hand the terminal to a different filesystem count. `su`, `sudo -i` and
 * friends change user but not filesystem, so they are not nested sessions.
 */

export type NestedSessionKind = 'remote' | 'container';

export interface NestedSession {
	/** 'remote' = another machine; 'container' = another filesystem, same host. */
	kind: NestedSessionKind;
	/** The program that opened it, e.g. "ssh", "docker". */
	program: string;
	/** The host / container it opened, when the argv makes it obvious. */
	target: string | null;
	/** The full in-flight command line, as captured. */
	command: string;
}

/** Wrappers that prefix the real command without changing what it does. */
const PREFIXES = new Set([
	'sudo',
	'doas',
	'command',
	'exec',
	'nohup',
	'time',
	'env',
	'stdbuf',
	'script'
]);

/** Programs that hand the terminal to another machine. */
const REMOTE_PROGRAMS = new Set(['ssh', 'autossh', 'mosh', 'telnet', 'rlogin', 'sshpass']);

/**
 * Programs whose *subcommand* decides: `docker exec` enters a container,
 * `docker ps` does not. Maps program → the subcommands that enter.
 */
const SUBCOMMAND_PROGRAMS: Record<string, { kind: NestedSessionKind; enters: string[] }> = {
	docker: { kind: 'container', enters: ['exec', 'attach', 'run'] },
	podman: { kind: 'container', enters: ['exec', 'attach', 'run'] },
	kubectl: { kind: 'container', enters: ['exec', 'attach'] },
	oc: { kind: 'container', enters: ['exec', 'rsh', 'attach'] },
	lxc: { kind: 'container', enters: ['exec', 'shell'] },
	incus: { kind: 'container', enters: ['exec', 'shell'] },
	distrobox: { kind: 'container', enters: ['enter'] },
	toolbox: { kind: 'container', enters: ['enter'] },
	machinectl: { kind: 'container', enters: ['shell', 'login'] },
	vagrant: { kind: 'remote', enters: ['ssh'] },
	virsh: { kind: 'remote', enters: ['console'] },
	tsh: { kind: 'remote', enters: ['ssh'] }
};

/** Single-word programs that always enter another filesystem. */
const CONTAINER_PROGRAMS = new Set(['nsenter', 'chroot', 'distrobox-enter', 'wsl', 'wsl.exe']);

/**
 * Flags that consume the next token, so the operand scan doesn't mistake a
 * flag's value for the host/container name. Kept per family because the same
 * letter means different things: `ssh -i key` takes a value, `docker exec -i`
 * does not. Getting one wrong costs a `target` of null, never a wrong
 * classification.
 */
const SSH_VALUE_FLAGS = new Set([
	'-p',
	'-i',
	'-l',
	'-o',
	'-F',
	'-J',
	'-L',
	'-R',
	'-D',
	'-W',
	'-w',
	'-b',
	'-c',
	'-E',
	'-e',
	'-I',
	'-m',
	'-O',
	'-Q',
	'-S',
	'--port',
	'--login-name',
	'--identity-file',
	'--ssh'
]);

const CONTAINER_VALUE_FLAGS = new Set([
	'-u',
	'-e',
	'-w',
	'-n',
	'-c',
	'--user',
	'--env',
	'--workdir',
	'--namespace',
	'--context',
	'--container'
]);

/** Split on whitespace; good enough for a command line we only pattern-match. */
function tokenize(commandLine: string): string[] {
	return commandLine.trim().split(/\s+/).filter(Boolean);
}

/** Strip `FOO=bar` assignments and wrapper programs off the front. */
function unwrap(tokens: string[]): string[] {
	let i = 0;
	while (i < tokens.length) {
		const t = tokens[i];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
			i++;
			continue;
		}
		if (PREFIXES.has(basename(t))) {
			i++;
			// `sudo -u tim ssh box`: skip the wrapper's own flags too.
			while (i < tokens.length && tokens[i].startsWith('-')) {
				if (CONTAINER_VALUE_FLAGS.has(tokens[i])) i++;
				i++;
			}
			continue;
		}
		break;
	}
	return tokens.slice(i);
}

function basename(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut >= 0 ? path.slice(cut + 1) : path;
}

/** First non-flag token, skipping flags and the values they consume. */
function firstOperand(tokens: string[], valueFlags: Set<string>): string | null {
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		// A bare `--` ends the flags; whatever follows is the remote command,
		// not the target (`kubectl exec pod -- bash`).
		if (t === '--') return null;
		if (t.startsWith('-')) {
			if (valueFlags.has(t)) i++;
			continue;
		}
		return t;
	}
	return null;
}

/**
 * Classify the terminal's in-flight command. Returns null when nothing is
 * running, or when what is running keeps the local filesystem (a build, a
 * server, a REPL, `su`) — in those cases the file tools are pointed at the
 * right place and there is nothing to warn about.
 */
export function classifyNestedSession(
	commandLine: string | null | undefined
): NestedSession | null {
	if (!commandLine) return null;
	// Only look at the last stage of a pipeline / chain: `cat x | ssh box sh`
	// still ends up inside ssh, while `ssh box uptime && vim f` does not.
	const lastStage = commandLine.split(/\|\||&&|;|\|/).pop() ?? commandLine;
	const tokens = unwrap(tokenize(lastStage));
	if (tokens.length === 0) return null;

	const program = basename(tokens[0]);
	const rest = tokens.slice(1);

	if (REMOTE_PROGRAMS.has(program)) {
		// `sshpass -p pw ssh box` — the real program is further along, past
		// sshpass's own flags (-p/-f/-d/-P each take a value).
		if (program === 'sshpass') {
			let i = 0;
			while (i < rest.length && rest[i].startsWith('-')) {
				if (['-p', '-f', '-d', '-P'].includes(rest[i])) i++;
				i++;
			}
			const inner = classifyNestedSession(rest.slice(i).join(' '));
			return inner ? { ...inner, command: commandLine.trim() } : null;
		}
		return {
			kind: 'remote',
			program,
			target: firstOperand(rest, SSH_VALUE_FLAGS),
			command: commandLine.trim()
		};
	}

	if (CONTAINER_PROGRAMS.has(program)) {
		return {
			kind: 'container',
			program,
			target: firstOperand(rest, CONTAINER_VALUE_FLAGS),
			command: commandLine.trim()
		};
	}

	const sub = SUBCOMMAND_PROGRAMS[program];
	if (sub) {
		// The entering verb isn't always the first operand (`kubectl -n ns exec
		// pod`), so look for it anywhere among the non-flag tokens.
		const entering = rest.filter((t) => !t.startsWith('-')).find((t) => sub.enters.includes(t));
		if (!entering) return null;
		// `docker run` only enters when it allocates a TTY; a plain
		// `docker run img cmd` runs and exits without owning the terminal.
		if (entering === 'run' && !rest.some((t) => /^-[a-zA-Z]*[it][a-zA-Z]*$/.test(t))) return null;
		const after = rest.slice(rest.indexOf(entering) + 1);
		const flags = sub.kind === 'remote' ? SSH_VALUE_FLAGS : CONTAINER_VALUE_FLAGS;
		return {
			kind: sub.kind,
			program,
			target: firstOperand(after, flags),
			command: commandLine.trim()
		};
	}

	// `gcloud compute ssh box`, `aws ssm start-session --target i-123`.
	if (program === 'gcloud' && rest.includes('ssh')) {
		return {
			kind: 'remote',
			program,
			target: firstOperand(rest.slice(rest.indexOf('ssh') + 1), SSH_VALUE_FLAGS),
			command: commandLine.trim()
		};
	}
	if (program === 'aws' && rest.includes('start-session')) {
		return { kind: 'remote', program, target: null, command: commandLine.trim() };
	}

	return null;
}

/** "`ssh box` — a remote host" / "`docker exec -it web sh` — a container". */
export function describeNestedSession(n: NestedSession): string {
	const what =
		n.kind === 'remote'
			? n.target
				? `a remote host (${n.target})`
				: 'a remote host'
			: n.target
				? `a container (${n.target})`
				: 'a container';
	return `\`${n.command}\` — ${what}`;
}

/** Where the file tools actually land, phrased for the model. */
const LOCAL_SIDE = 'this machine (the one Haruspex runs on)';

/**
 * The block dropped into the system prompt while a nested session is in
 * flight. States the split once, in the place the model reads every turn.
 * The two Shell prompts need different advice: Code mode drives the session
 * itself, while the read-only assistant only *suggests* commands — which the
 * user pastes into that same session, so they land on the remote host too.
 */
export function nestedSessionPromptBlock(n: NestedSession, mode: 'code' | 'chat'): string {
	const there = n.kind === 'remote' ? 'that host' : 'that container';
	const head = `ATTENTION — the terminal is currently INSIDE ${describeNestedSession(n)}.`;
	if (mode === 'chat') {
		return [
			head,
			`- Commands you suggest get pasted into that session, so they run on ${there}, not here. Tailor them to it — its OS, package manager and paths may differ from SESSION CONTEXT above, so ask rather than assume.`,
			`- fs_read_text and fs_list_dir read ${LOCAL_SIDE}. They CANNOT see files on ${there}, and the working directory above is the local one, not the shell's. To inspect a file over there, suggest a \`cat\`/\`ls\` command instead of reading it yourself.`,
			`- Never present something you read locally as the state of ${there}.`
		].join('\n');
	}
	return [
		head,
		`- run_command, shell_input and shell_read act on ${there}.`,
		`- The file tools (fs_read_text, fs_list_dir, fs_write_text, fs_edit_text, code_grep, code_glob) act on ${LOCAL_SIDE}. They CANNOT see or change files on ${there}, and the current directory shown above is the local one, not the shell's.`,
		`- To read a file on ${there}, run \`cat\`/\`ls\` through the session. To change one, send a \`cat > path <<'EOF' … EOF\` heredoc or \`sed -i\` the same way — never fs_write_text/fs_edit_text.`,
		`- Never report a file as changed on ${there} when you wrote it with a file tool.`,
		`- If the user actually wants local work, leave the session first (\`exit\`) and say so.`
	].join('\n');
}

/**
 * Refusal for a write attempted while the terminal is elsewhere. Blocking
 * rather than warning: the warning arrives after the wrong file already
 * exists, and a stray local file is exactly what the user was complaining
 * about.
 */
export function nestedWriteBlockedMessage(tool: string, n: NestedSession): string {
	const there = n.kind === 'remote' ? 'that host' : 'that container';
	return (
		`${tool} did not run. The terminal is inside ${describeNestedSession(n)}, but the file ` +
		`tools always write to ${LOCAL_SIDE} — this would have created a local file, not the one ` +
		`you are looking at. Make the change on ${there} through the session instead: send it with ` +
		`shell_input, e.g. a \`cat > <path> <<'EOF' … EOF\` heredoc or \`sed -i\`. If you meant to ` +
		`edit a local file, exit the session first (shell_input \`exit\`) and say why.`
	);
}

/**
 * Suffix appended to a read/search result produced while the terminal is
 * elsewhere. The data is real, it just describes the wrong machine — say so
 * rather than letting the model read it as the remote file.
 */
export function nestedReadNote(n: NestedSession): string {
	const there = n.kind === 'remote' ? 'that host' : 'that container';
	return (
		`\n\n(NOTE: this came from ${LOCAL_SIDE}, NOT from ${there} — the terminal is inside ` +
		`${describeNestedSession(n)} and the file tools do not reach it. To look at the ` +
		`corresponding file on ${there}, run \`cat\`/\`ls\` through the session.)`
	);
}
