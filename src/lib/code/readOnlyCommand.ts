/**
 * Commands that can't change files, so a Code session runs them without
 * taking its folder's writer lease (`#lib/code/folders.ts`), and a read-only
 * subtask runs them at all.
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
	'[',
	'cd',
	'pushd',
	'popd',
	'read',
	'jq',
	'tac',
	'rev',
	'paste',
	'comm',
	'column',
	'seq',
	'md5sum',
	'sha256sum'
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

/** Shell words that wrap a command without running anything themselves. */
const KEYWORDS = new Set([
	'if',
	'then',
	'else',
	'elif',
	'fi',
	'while',
	'until',
	'do',
	'done',
	'time',
	'!',
	'{',
	'}'
]);

/** `FOO=1` before a command: the assignment changes nothing on disk. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A redirection that writes nowhere: `2>/dev/null`, `&>/dev/null`, `2>&1`. */
const HARMLESS_REDIRECT = /^[\d&]?>(?:\s*\/dev\/null|&\d)/;

/** xargs options that take a value. */
const XARGS_WITH_VALUE = new Set(['-n', '-I', '-d', '-P', '-L', '-s', '-E', '-a']);

/** sed long options that change nothing. */
const SED_LONG = new Set([
	'--quiet',
	'--silent',
	'--regexp-extended',
	'--separate',
	'--unbuffered',
	'--null-data',
	'--posix',
	'--debug',
	'--sandbox'
]);

/** sed commands that only print, drop lines from the output, or move text between buffers. */
const SED_PLAIN = 'pdqQ=lnNPDgGhHxz';

export function isReadOnlyCommand(command: string): boolean {
	const parts = splitCommand(command);
	return parts !== null && parts.every(wordsRead);
}

/**
 * The simple commands in `command`, each as its unquoted words. Null when it
 * redirects into a file or runs a command inside another one. Separators and
 * redirections inside quotes are text, as in the shell: `grep -E "a|b"`.
 */
function splitCommand(command: string): string[][] | null {
	const parts: string[][] = [];
	let words: string[] = [];
	let word = '';
	let inWord = false;
	let quote = '';
	const endWord = () => {
		if (inWord) words.push(word);
		word = '';
		inWord = false;
	};
	const endPart = () => {
		endWord();
		if (words.length) parts.push(words);
		words = [];
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		const next = command[i + 1];
		if (quote === "'") {
			if (c === "'") quote = '';
			else word += c;
			continue;
		}
		// Double quotes still expand `$(…)` and backticks.
		if (c === '`' || (c === '$' && next === '(')) return null;
		if (quote === '"') {
			if (c === '"') quote = '';
			else if (c === '\\' && next !== undefined) word += command[++i];
			else word += c;
			continue;
		}
		if (c === '\\') {
			word += next ?? '';
			i++;
			inWord = true;
		} else if (c === "'" || c === '"') {
			quote = c;
			inWord = true;
		} else if (c === ' ' || c === '\t') {
			endWord();
		} else if (c === '>' || (next === '>' && !inWord && (c === '&' || /\d/.test(c)))) {
			const harmless = HARMLESS_REDIRECT.exec(command.slice(i));
			if (!harmless) return null;
			endWord();
			i += harmless[0].length - 1;
		} else if (c === '<' && next === '(') {
			return null;
		} else if (';|&()\n'.includes(c)) {
			endPart();
		} else {
			word += c;
			inWord = true;
		}
	}
	if (quote) return null;
	endPart();
	return parts;
}

/** Whether one simple command, as its words, only reads. */
function wordsRead(all: string[]): boolean {
	const words = [...all];
	while (words.length && (KEYWORDS.has(words[0]) || ASSIGNMENT.test(words[0]))) words.shift();
	if (words.length === 0) return true;
	const [prog, ...args] = words;
	// `for f in a b` only names the words the loop's body sees.
	if (prog === 'for') return true;
	if (READERS.has(prog)) return true;
	if (prog === 'sort') return !args.some((a) => a === '-o' || a.startsWith('--output'));
	if (prog === 'find') return !args.some((a) => FIND_WRITERS.test(a));
	if (prog === 'git') return gitReads(args);
	if (prog === 'sed') return sedReads(args);
	if (prog === 'xargs') return xargsReads(args);
	return false;
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

/** `xargs cmd` reads when `cmd` does; bare `xargs` only echoes. */
function xargsReads(args: string[]): boolean {
	let i = 0;
	while (i < args.length && args[i].startsWith('-')) i += XARGS_WITH_VALUE.has(args[i]) ? 2 : 1;
	return i >= args.length || wordsRead(args.slice(i));
}

/** sed without `-i`, `-f`, or a script that writes (`w`) or runs (`e`) anything. */
function sedReads(args: string[]): boolean {
	const scripts: string[] = [];
	const operands: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--expression') {
			if (i + 1 >= args.length) return false;
			scripts.push(args[++i]);
		} else if (a.startsWith('--expression=')) {
			scripts.push(a.slice('--expression='.length));
		} else if (a === '-l' || a === '--line-length') {
			i++;
		} else if (a.startsWith('--')) {
			if (!SED_LONG.has(a)) return false;
		} else if (a.startsWith('-') && a.length > 1) {
			// A cluster of short flags; `e` takes the rest of it, or the next word.
			for (let j = 1; j < a.length; j++) {
				if ('nErsuz'.includes(a[j])) continue;
				if (a[j] !== 'e') return false;
				const rest = a.slice(j + 1);
				if (rest) scripts.push(rest);
				else if (i + 1 < args.length) scripts.push(args[++i]);
				else return false;
				break;
			}
		} else {
			operands.push(a);
		}
	}
	if (scripts.length === 0) {
		if (operands.length === 0) return false;
		scripts.push(operands[0]);
	}
	return scripts.every(sedScriptReads);
}

/**
 * Whether a sed script only prints and edits the stream: addresses, `s` and
 * `y` without the `w` or `e` flags, and the commands in SED_PLAIN. Anything
 * else (`w file`, `e cmd`, `r`, a flag we don't know) counts as a writer.
 */
function sedScriptReads(s: string): boolean {
	let i = 0;
	const skipSeparators = () => {
		while (i < s.length && /[\s;]/.test(s[i])) i++;
	};
	// Past text ending at an unescaped `d`; false when it never ends.
	const delimited = (d: string): boolean => {
		while (i < s.length && s[i] !== d) i += s[i] === '\\' ? 2 : 1;
		if (i >= s.length) return false;
		i++;
		return true;
	};
	const address = (): boolean => {
		if (/\d/.test(s[i] ?? '')) {
			while (/[\d~]/.test(s[i] ?? '')) i++;
		} else if (s[i] === '$') {
			i++;
		} else if (s[i] === '/' || s[i] === '\\') {
			const slash = s[i] === '/';
			const d = slash ? '/' : s[i + 1];
			if (!d) return false;
			i += slash ? 1 : 2;
			if (!delimited(d)) return false;
			while (/[IM]/.test(s[i] ?? '')) i++;
		}
		return true;
	};
	skipSeparators();
	while (i < s.length) {
		if (!address()) return false;
		if (s[i] === ',') {
			i++;
			if (s[i] === '+' || s[i] === '~') i++;
			if (!address()) return false;
		}
		while (s[i] === ' ' || s[i] === '!') i++;
		const c = s[i++] ?? '';
		if (c === 's' || c === 'y') {
			const d = s[i++];
			if (!d || d === '\\' || d === '\n') return false;
			if (!delimited(d) || !delimited(d)) return false;
			if (c === 's') while (/[gpiImM\d]/.test(s[i] ?? '')) i++;
		} else if (c === '{') {
			skipSeparators();
			continue;
		} else if (c === '' || (c !== '}' && !SED_PLAIN.includes(c))) {
			return false;
		}
		while (s[i] === ' ' || s[i] === '\t') i++;
		if (i < s.length && !/[;\n}]/.test(s[i])) return false;
		skipSeparators();
	}
	return true;
}
