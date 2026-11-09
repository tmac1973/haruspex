/**
 * Resolve a tool `path` argument for Shell-mode dispatch. The Shell
 * agent's `fs_*_absolute` Rust commands require absolute paths, but
 * models naturally emit bare/relative names (`snake_game.py`) the way a
 * person would at a terminal — so the first call errors with "Path must
 * be absolute". When we know the shell's current working directory,
 * resolve relative paths against it so the call lands on the first try.
 * Already-absolute paths (POSIX or Windows) and the no-cwd fallback pass
 * through unchanged; `..`/`.` segments are left for the OS to normalize.
 */
export function resolveShellPath(path: string, shellCwd: string | null | undefined): string {
	if (typeof path !== 'string' || !path || !shellCwd) return path;
	const isAbsolute =
		path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
	if (isAbsolute) return path;
	const base = shellCwd.replace(/[/\\]+$/, '');
	const rel = path.replace(/^\.\//, '');
	return `${base}/${rel}`;
}
