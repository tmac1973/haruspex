/**
 * Whether a shell session runs fish. Fish is not POSIX: a bash one-liner is a
 * parse error there, which fish reports by printing a complaint and redrawing
 * its prompt rather than by running a command that fails.
 */
export function isFish(ctx: { shellPath?: string | null; shellName?: string | null }): boolean {
	return /(^|\/)fish$/.test(ctx.shellName ?? '') || /(^|\/)fish$/.test(ctx.shellPath ?? '');
}
