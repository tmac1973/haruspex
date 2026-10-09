/**
 * Commands that can't change files, so a Code session runs them without
 * taking its folder's writer lease (`#lib/code/folders.ts`).
 *
 * Deliberately narrow: a command is read-only only when every part of it is
 * a known reading program and nothing redirects output into a file. Anything
 * else — a build, a test run, `npm install`, an unknown script — is treated
 * as a writer, which only costs waiting for the folder.
 */

/** Programs that only read, whatever their arguments. */
const READERS = new Set([
	'ls',
	'cat',
	'head',
	'tail',
	'wc',
	'grep',
	'egrep',
	'fgrep',
	'rg',
	'tree',
	'pwd',
	'echo',
	'printf',
	'which',
	'type',
	'file',
	'stat',
	'du',
	'df',
	'diff',
	'cmp',
	'uniq',
	'cut',
	'tr',
	'nl',
	'basename',
	'dirname',
	'realpath',
	'readlink',
	'date',
	'uname',
	'whoami',
	'id',
	'true',
	'false',
	'test',
	'['
]);

/** git subcommands that only read. Some take extra checks below. */
const GIT_READERS = new Set([
	'status',
	'log',
	'diff',
	'show',
	'rev-parse',
	'ls-files',
	'ls-tree',
	'blame',
	'describe',
	'shortlog',
	'grep',
	'cat-file',
	'branch',
	'tag',
	'remote'
]);

/** Flags that keep `git branch` / `tag` / `remote` to listing. */
const GIT_LIST_FLAGS = new Set([
	'-a',
	'-r',
	'-v',
	'-vv',
	'-l',
	'--list',
	'--all',
	'--remotes',
	'--verbose',
	'--show-current',
	'--no-color',
	'--color'
]);

/** `find` actions that change or write files. */
const FIND_WRITERS = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;

/** Redirections that write nowhere. */
const HARMLESS_REDIRECTS = /\d?>\s*\/dev\/null|\d?>&\d/g;

export function isReadOnlyCommand(command: string): boolean {
	const cmd = command.replace(HARMLESS_REDIRECTS, ' ');
	// Output into a file, or a command run inside another one.
	if (/[>`]|\$\(|<\(/.test(cmd)) return false;
	const parts = cmd.split(/&&|\|\||[;|\n&]/);
	return parts.every((part) => {
		const words = part.trim().split(/\s+/).filter(Boolean);
		// `FOO=1 cmd`: the assignment changes nothing on disk.
		while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
		if (words.length === 0) return true;
		const [prog, ...args] = words;
		if (READERS.has(prog)) return true;
		if (prog === 'sort') return !args.some((a) => a === '-o' || a.startsWith('--output'));
		if (prog === 'find') return !args.some((a) => FIND_WRITERS.test(a));
		if (prog === 'git') return gitReads(args);
		return false;
	});
}

function gitReads(args: string[]): boolean {
	// Global options before the subcommand (`-C dir`, `--no-pager`).
	let i = 0;
	while (i < args.length && args[i].startsWith('-'))
		i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
	const sub = args[i];
	const rest = args.slice(i + 1);
	if (!sub || !GIT_READERS.has(sub)) return false;
	if (sub === 'branch' || sub === 'tag' || sub === 'remote') {
		return rest.every((a) => GIT_LIST_FLAGS.has(a));
	}
	return !rest.some((a) => a === '--output' || a.startsWith('--output='));
}
