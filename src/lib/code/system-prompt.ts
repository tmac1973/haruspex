/**
 * The Code tab's system prompt: commands run one-shot in the session's project
 * folder, with no terminal behind them. (The Shell's Full access uses the
 * shell assistant prompt instead, `#lib/shell/system-prompt.ts`.)
 */

import type { ChatMessage } from '#lib/api.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { formatTodayLong } from '#lib/utils/format.ts';
import { GUIDE_PROMPT } from '#lib/guide/prompt.ts';

const SEARCH_AND_FILE_TOOLS = `- code_grep — search file CONTENTS (gitignore-aware); returns file:line locations, not bodies. Find where something is defined/used, then read those lines.
- code_glob — find files by path glob (e.g. "src/**/*.ts").
- fs_read_text — read a file; pass offset (1-indexed start line) + limit to read a slice of a large file.
- fs_write_text — create or overwrite a file.
- fs_edit_text — targeted edit; old_str must UNIQUELY match (include surrounding context). Prefer small precise edits over rewriting whole files.`;

const WEB_TOOLS =
	'- web_search / research_url — look up current docs or unfamiliar APIs when needed.\n' +
	"- For a page's exact text (code samples, raw files, release notes), curl it with run_command.";

const HOW_TO_WORK = `HOW TO WORK:
- Explore before editing: grep/glob to locate code, read the relevant slices, then change it.
- Verify your work: after editing, run the project's own build / test / lint via run_command and fix what breaks before reporting done.
- Keep context small: read slices not whole files; don't dump large command output.
- SCRATCHPAD: for multi-step tasks, write a brief plan or notes to NOTES.md / PLAN.md with fs_write_text and re-read slices, rather than holding everything in your head.
- Make the smallest change that solves the task, and explain what you changed and why — concisely.`;

const UNIX_CAPTURE_NOTE =
	'Prefer non-interactive flags (e.g. --no-pager, CI=1); avoid full-screen TUIs/pagers (less, vim, top) — they capture poorly.';

/**
 * macOS runs commands with its system bash, 3.2, which predates bash 4. Named
 * in the prompt there only, since elsewhere the features work.
 */
const MAC_BASH_NOTE =
	"Commands run in macOS's bash 3.2: avoid bash-4 features — associative arrays (declare -A), ${var,,} / ${var^^}, mapfile / readarray, |& and globstar (**). Use tr, while-read loops and 2>&1 | instead.";

/**
 * A session inside a WSL distro (Windows): Linux, whatever the host is. WSL
 * puts the Windows PATH on the distro's, so `node.exe` or `git.exe` can run
 * by mistake; and under WSL2's default NAT networking the distro's
 * `localhost` is not the Windows host's.
 */
function wslNote(distro: string): string {
	return `The project is inside the WSL distro ${distro}: commands run there, in Linux with bash, and paths are Linux paths. Windows programs on its PATH (*.exe) run on Windows, not in the distro — use the Linux tools. localhost in the distro may not reach servers on the Windows side.`;
}

/**
 * A session in a Windows folder: PowerShell, not bash. 5.1 has no `&&`
 * or `||`, which models reach for first.
 */
function powershellNote(ps: { pwsh: boolean }): string {
	const which = ps.pwsh ? 'PowerShell 7' : 'Windows PowerShell 5.1';
	const chain = ps.pwsh
		? ''
		: ' It has no && or ||: separate commands with ; and test $? (npm ci; if ($?) { npm test }).';
	return `The project is a Windows folder: commands run in ${which}, not bash, and paths are Windows paths. Use PowerShell (Get-ChildItem, Select-String, $env:NAME) or native programs (git, npm, python).${chain}`;
}

/** True on macOS. The platform comes from the user agent. */
export function isMacOS(
	userAgent = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
): boolean {
	return /Macintosh|Mac OS X/i.test(userAgent);
}

/** Textures need no image backend; the other kinds are named only with one. */
function assetLine(): string {
	return getSettings().imageBackendKind !== 'none'
		? '\n- make_asset — make art for the project: a sprite, icon or tiling texture (or a plain picture), written as a PNG at the size the project uses. Pass palette_from with an existing asset to keep a set consistent. A texture, or a transition set where two textures meet (pass the recipes you used), is drawn by code from recipes you write, in a second; the rest take a minute or more. For a painted material that must tile, pass seamless: true with kind image. Check the result before moving on.'
		: '\n- make_asset — make a tiling texture for the project, or a transition set where two textures meet, drawn by code from recipes you write, as PNGs at the size the project uses. Sprites and icons need image generation in Settings → Image. Check the result before moving on.';
}

/** generate_music and edit_music, when Settings → Music has a backend. */
function musicLine(readOnly: boolean | undefined): string {
	if (getSettings().musicBackendKind === 'none') return '';
	const save = readOnly
		? ''
		: ' Pass path (ending .mp3 or .wav) to also save it into the project; save_generated saves one made earlier.';
	return `\n- generate_music — make a song or instrumental from a caption of tags, with lyrics if it has vocals. It takes a minute or more and plays in your answer.${save}\n- edit_music — a new version of a song made earlier or a file in the project: restyle it, redo or extend a stretch, or add or pull out an instrument.`;
}

/** Custom instructions, then the repo's AGENTS.md, then the skill list. */
function tail(opts: { projectInstructions?: string; skillsSection?: string }): string {
	const custom = getSettings().customSystemPrompt?.trim();
	const customBlock = custom ? `\n\nCUSTOM INSTRUCTIONS:\n${custom}` : '';
	return [customBlock, opts.projectInstructions, opts.skillsSection].join('');
}

export interface BuildCodePromptOpts {
	/** The session's project folder: where commands run and the boundary. */
	root: string;
	/** The turn's skill list (`skillsPromptSection`), when it has one. */
	skillsSection?: string;
	/** The repo's AGENTS.md (`agentsMdPromptSection`), when trusted. */
	projectInstructions?: string;
	/** The session may read, not write (a fork sharing its source's folder). */
	readOnly?: boolean;
	/** The folder is a fresh git worktree made for this session (a fork). */
	worktree?: { branch: string | null };
	/** Running on macOS (bash 3.2). Defaults to the user agent's platform. */
	macOS?: boolean;
	/** The WSL distro the folder is in (Windows); commands run there, not on the host. */
	wslDistro?: string | null;
	/** A Windows folder: the PowerShell its commands run in (`agentPowershell`). */
	powershell?: { pwsh: boolean } | null;
	/**
	 * The turn has `open_in_shell` (default): a Shell tab works here and the
	 * user is at this computer, not driving it from another.
	 */
	shellHandoff?: boolean;
	/** The turn has `delegate`, offering these modes (Settings → Code → Subtasks). */
	delegate?: 'read' | 'write';
	/**
	 * The turn is a subtask's: `task` is what the parent agent handed it.
	 * With `worktree` it writes, in that copy of the project, sharing the
	 * `linked` dependency folders with it.
	 */
	subtask?: { task: string; worktree?: { root: string; linked: string[] } };
}

const WRITE_TOOL_LINE = /^- fs_(write|edit)_text /;

/** The file tools, without the write and edit ones for a read-only session. */
function fileTools(readOnly = false): string {
	if (!readOnly) return SEARCH_AND_FILE_TOOLS;
	return SEARCH_AND_FILE_TOOLS.split('\n')
		.filter((l) => !WRITE_TOOL_LINE.test(l))
		.join('\n');
}

/** What is true of this session's folder beyond its path. */
function sessionNotes(opts: BuildCodePromptOpts): string {
	const notes: string[] = [];
	if (opts.readOnly) {
		notes.push(
			"This session is READ-ONLY: it shares its folder with another session, so you cannot write or edit files. Read, search and research; when a change is wanted, describe it (or show the diff) instead of making it. Every run_command needs the user's approval, and background commands are refused."
		);
	}
	if (opts.worktree) {
		const on = opts.worktree.branch ? ` on branch ${opts.worktree.branch}` : '';
		notes.push(
			`This folder is a fresh git worktree${on}, made for this session. Ignored files are not in it — no node_modules, .env or build output — so set up dependencies (install packages, copy any needed config) before building or testing.`
		);
	}
	return notes.map((n) => `\n${n}`).join('');
}

/**
 * What the commands run on, when it needs saying: a WSL distro, PowerShell
 * in a Windows folder, or macOS's old bash.
 */
function platformNote(opts: BuildCodePromptOpts): string {
	if (opts.wslDistro) return ` ${wslNote(opts.wslDistro)}`;
	if (opts.powershell) return ` ${powershellNote(opts.powershell)}`;
	return (opts.macOS ?? isMacOS()) ? ` ${MAC_BASH_NOTE}` : '';
}

const HANDOFF_TOOL =
	'- open_in_shell — hand ONE command to the user: it opens a Shell tab at the project folder with the command typed in, the user presses Enter, and you get the exit code and output (and the command that ran, if they changed it).\n';

/** The `open_in_shell` line in TOOLS, when the turn has it. */
function handoffToolLine(opts: BuildCodePromptOpts): string {
	return (opts.shellHandoff ?? true) ? HANDOFF_TOOL : '';
}

/** What to do with a command that needs a password or a terminal. */
function handoffRule(opts: BuildCodePromptOpts): string {
	const cannot =
		'A command that needs a password or a terminal (sudo, an interactive installer, a login prompt) cannot run with run_command.';
	return (opts.shellHandoff ?? true)
		? `${cannot} Use open_in_shell for it, and say in your reply what it is for. Do not use open_in_shell for commands run_command can run.`
		: `${cannot} Say in your reply what to run and why; the user runs it themselves, at this computer.`;
}

/** The most a subtask's report may run to before the parent's copy is cut. */
export const SUBTASK_REPORT_CHARS = 4000;

const DELEGATE_READ = `

SUBTASKS:
- delegate — hand a self-contained part of the request to a helper agent. It starts with an empty context in this folder and returns a short report (paths and line numbers, not file contents). It cannot see this conversation or ask the user anything.
- mode read: it reads, searches and runs read-only commands. Use it for independent parts that need many files read: "find every caller of X and how they handle errors", "work out how the tests mock Y". Not for one file you could read yourself, or for work that depends on another part's answer.
- When a request has several independent parts, delegate them in your FIRST response, before reading files yourself: the subtasks run at the same time and keep your own context small. Do the parts that depend on their answers after they report.
- Write each task in full: what to find out or change, where to start, and what the report must contain.
- Several delegate calls in one response run at the same time where the server allows it; at most 8 per turn.
- background: true returns at once and the subtask runs on after your answer; its report arrives in a notification turn. Use it for work you don't need before answering; don't wait or poll for it.`;

const DELEGATE_WRITE = `
- mode write: it makes a change in its own copy of the project, made from this folder as it is now, and can build and test there. When it finishes, its changes are applied to this folder for you; the result lists the files, or the conflict and the patch if they clash with changes made meanwhile. Give writers changes that touch different files from each other and from what you are editing, and check the applied files afterwards.`;

/** Numbered items ("1." or "2)") at the start of a line. */
const NUMBERED_ITEM = /^\s*\d+[.)]\s+\S/gm;

/** The fewest numbered asks in one message that earn a hint to delegate. */
export const DELEGATION_HINT_MIN_ASKS = 3;

/**
 * A note for a turn whose message lists several numbered asks, pointing at
 * `delegate`: models that ignore the SUBTASKS section of the prompt follow a
 * note on the message itself. Null with fewer asks or without the tool.
 */
export function delegationHint(
	text: string,
	modes: BuildCodePromptOpts['delegate']
): string | null {
	if (!modes) return null;
	const asks = text.match(NUMBERED_ITEM)?.length ?? 0;
	if (asks < DELEGATION_HINT_MIN_ASKS) return null;
	const write =
		modes === 'write'
			? ' Changes that touch different files can go to writing subtasks (mode write).'
			: '';
	return `This message lists ${asks} separate asks. Where they are independent of each other, hand each to a subtask with delegate in one response, so they run at the same time, instead of working through them yourself one after another.${write}`;
}

function delegateSection(modes: BuildCodePromptOpts['delegate']): string {
	if (!modes) return '';
	return DELEGATE_READ + (modes === 'write' ? DELEGATE_WRITE : '');
}

/** What a subtask may do in its folder, and its tools for it. */
function subtaskSession(worktree: { root: string; linked: string[] } | undefined): {
	rules: string;
	tools: string;
	run: string;
} {
	if (!worktree) {
		return {
			rules:
				'You may read, not write: no file writes or edits. run_command runs only commands that read (ls, cat, grep, sed -n, git log, git diff…); anything else is refused, tests, builds and installs included. Name the ones worth running in the report instead.',
			tools: fileTools(true),
			run: '- run_command — run ONE read-only shell command; returns output + exit code.'
		};
	}
	const shared = worktree.linked.length
		? ` ${worktree.linked.join(', ')} ${worktree.linked.length === 1 ? 'is' : 'are'} shared with the original folder: use what is installed, but don't install, upgrade or delete anything in ${worktree.linked.length === 1 ? 'it' : 'them'}.`
		: ' Dependencies may not be installed here; if a build needs them, say so in the report rather than installing.';
	return {
		rules: `This folder is your own copy of the project, made for this task from the original as it was when you started. Edit files and run commands here; when you finish, your changes are applied to the original for you. Don't commit, and don't touch anything outside this folder.${shared} A command may need the user's approval; if it is denied, take another way or say so in the report.`,
		tools: fileTools(false),
		run: '- run_command — run ONE shell command (build, test, lint); returns output + exit code. Nothing may keep running after you finish, so no background commands.'
	};
}

/** A subtask's prompt: the parent's task, its tools, a report at the end. */
function buildSubtaskPrompt(opts: BuildCodePromptOpts, task: string): ChatMessage {
	const timeout = getSettings().codeRunCommandTimeoutSecs;
	const worktree = opts.subtask?.worktree;
	const session = subtaskSession(worktree);
	const verify = worktree
		? "\n- After changing files, run the project's own build or tests for what you changed and fix what breaks."
		: '';
	return {
		role: 'system',
		content: `You are a subtask of Haruspex's coding agent, working in a project folder. Another agent handed you one task; do that task and nothing else. Nobody will answer questions: decide for yourself, and say in the report what you assumed. Today is ${formatTodayLong()}.

YOUR TASK:
${task}

SESSION:
Project folder: ${worktree?.root ?? opts.root}
${session.rules} Commands run one at a time in the project folder without a terminal, time out after ${timeout}s, and a \`cd\` does not carry over between calls. Paths for file tools are relative to the project folder.${platformNote(opts)}

TOOLS:
${session.tools}
${session.run} ${UNIX_CAPTURE_NOTE}
${WEB_TOOLS}

HOW TO WORK:
- Search first (code_grep, code_glob), then read only the slices you need.${verify}
- Stop once the task is done; don't go beyond it.

REPORT:
Your final answer is the report the other agent receives, and the only thing it sees of your work. Keep it under ${SUBTASK_REPORT_CHARS} characters: what you found${worktree ? ' and changed, and whether the build and tests pass' : ''}, with file paths and line numbers, and anything you could not settle. Quote code only where a line or two is the answer.${tail(opts)}`
	};
}

/** The Code tab's prompt: one-shot commands in a fixed project folder. */
export function buildCodeSystemPrompt(opts: BuildCodePromptOpts): ChatMessage {
	if (opts.subtask) return buildSubtaskPrompt(opts, opts.subtask.task);
	const timeout = getSettings().codeRunCommandTimeoutSecs;
	return {
		role: 'system',
		content: `You are Haruspex's coding agent, working in a project folder. Today is ${formatTodayLong()}.

${GUIDE_PROMPT}

SESSION:
Project folder: ${opts.root}${sessionNotes(opts)}

Commands you run with run_command execute one at a time in the project folder, without a terminal: nothing can be typed into them, and a \`cd\` or an exported variable does not carry over to the next call, so chain with && when needed. Paths for file tools are relative to the project folder. The project folder is your boundary: a command that reaches outside it needs the user's approval.${platformNote(opts)}

TOOLS:
${fileTools(opts.readOnly)}
- run_command — run ONE shell command; it runs to completion and returns combined output + exit code. ${UNIX_CAPTURE_NOTE} A foreground command times out (default ${timeout}s) if it doesn't exit — for anything long-running use background/watch instead. Options: background:true runs it detached and returns an id at once; watch:true does the same and notifies you with a follow-up turn when it finishes (exit code + output).
- command_output — the latest output of a background command, by the id run_command returned, and whether it is still running.
- command_stop — stop a background command, and everything it started.
${handoffToolLine(opts)}- open_in_editor — open files in an editor window for the user to look at. It returns at once and does not report their edits.
${WEB_TOOLS}${assetLine()}${musicLine(opts.readOnly)}${delegateSection(opts.delegate)}

RUNNING PROCESSES:
- Servers / watchers / GUIs (anything that does not exit on its own): start them with run_command background:true. Check on one with command_output and stop it with command_stop when you are done with it. Do NOT run these in the foreground — they will just time out.
- A long build / test / job whose result you need but don't want to block on: run it with watch:true. You'll get a follow-up turn with its exit code and output when it finishes — so continue with other work or wrap up; do NOT sit and poll for it.
- Background commands are stopped when this session closes.
- ${handoffRule(opts)}

${HOW_TO_WORK}${tail(opts)}`
	};
}
