/**
 * Render a sandbox run result as the text handed back to the model / stored
 * in the transcript. This stays a near-leaf module on purpose: both the
 * run_python tool (`#lib/agent/tools/sandbox`) and the chat store need it,
 * and the chat store must not import the agent tools module (circular).
 */

import { truncateCapturedOutput } from '#lib/shell/truncate.ts';

/**
 * Most of each output stream (stdout, stderr, the final value) handed back.
 * Without a cap one `print(resp.text)` of an API that ignored its filter put
 * 900 KB in the prompt, over the whole context window, and the pre-send
 * guard then cut it down to a quarter of the window that rode along in every
 * call after.
 */
export const SANDBOX_OUTPUT_MAX_BYTES = 20 * 1024;

const PYTHON_HINT =
	'Variables you assigned still hold the full data: print a filtered slice, a count or a summary instead of the whole value';

function capped(text: string): string {
	return truncateCapturedOutput(text, SANDBOX_OUTPUT_MAX_BYTES, PYTHON_HINT).text;
}

/** Structural subset of `ToolResult` (from `#lib/sandbox/sandbox`) needed to render. */
export interface SandboxRunOutput {
	stdout: string;
	stderr: string;
	result: string;
	error: string | null;
	artifacts: number;
	notes: string[];
	duration_ms: number;
}

export function formatSandboxResult(output: SandboxRunOutput): string {
	const r = {
		...output,
		stdout: capped(output.stdout.trim()),
		stderr: capped(output.stderr.trim()),
		result: capped(output.result)
	};
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
