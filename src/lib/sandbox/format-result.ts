/**
 * Render a sandbox run result as the text handed back to the model / stored
 * in the transcript. This is a leaf module (no imports) on purpose: both the
 * run_python tool (`$lib/agent/tools/sandbox`) and the chat store need it,
 * and the chat store must not import the agent tools module (circular).
 */

/** Structural subset of `ToolResult` (from `$lib/sandbox/sandbox`) needed to render. */
export interface SandboxRunOutput {
	stdout: string;
	stderr: string;
	result: string;
	error: string | null;
	artifacts: number;
	notes: string[];
	duration_ms: number;
}

export function formatSandboxResult(r: SandboxRunOutput): string {
	const lines: string[] = [];
	if (r.error) {
		lines.push(`Error: ${r.error}`);
		if (r.stderr.trim()) lines.push(`Stderr:\n${r.stderr.trim()}`);
		if (r.stdout.trim()) lines.push(`Stdout:\n${r.stdout.trim()}`);
		lines.push(`(took ${r.duration_ms}ms)`);
		return lines.join('\n\n');
	}
	if (r.stdout.trim()) lines.push(`Stdout:\n${r.stdout.trim()}`);
	if (r.stderr.trim()) lines.push(`Stderr:\n${r.stderr.trim()}`);
	if (r.result) lines.push(`Result: ${r.result}`);
	if (r.artifacts > 0) {
		// Be explicit and directive: small models otherwise read a vague
		// "rendered in UI" and still try to "show" the figure by hand-writing
		// markdown image links or <iframe> tags to invented file paths.
		const s = r.artifacts === 1 ? '' : 's';
		lines.push(
			`(${r.artifacts} figure${s}/artifact${s} already rendered inline in the chat and ` +
				`shown to the user automatically — do NOT embed them again, reference any file ` +
				`path, or write image/iframe markup for them; just describe them in your reply.)`
		);
	}
	if (r.notes.length > 0) lines.push(`Notes: ${r.notes.join('; ')}`);
	if (lines.length === 0) lines.push('(no output)');
	lines.push(`(took ${r.duration_ms}ms)`);
	return lines.join('\n\n');
}
