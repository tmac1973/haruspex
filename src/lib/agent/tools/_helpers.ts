/**
 * Tool-shared helpers — used by web.ts, email.ts, fs-write.ts, and the
 * various read tools. Keeping these here lets individual tool modules
 * stay focused on their own schemas and prompts, while the boilerplate
 * (sub-agent sampling params, proxy_fetch payload shape, error
 * formatting, displayLabel accessor) lives in one place.
 */

import { invoke } from '@tauri-apps/api/core';
import { chatCompletion, type ChatMessage } from '$lib/api';
import { getChatTemplateKwargs, getSamplingParams, getSettings } from '$lib/stores/settings';
import { resolveBackendDescriptor } from '$lib/inference/descriptor';
import { errMessage } from '$lib/utils/error';
import { toolError } from './types';

/**
 * Build a `displayLabel` function that pulls one named arg as a string.
 * Used by ~80% of tools whose label is just `(args) => (args.path as string) || ''`.
 */
export const labelArg =
	(key: string) =>
	(args: Record<string, unknown>): string =>
		(args[key] as string) ?? '';

/**
 * Prefixes a fetch/research tool result uses to signal failure. The agent
 * loop (to skip recording a citation) and the chat store (to skip showing a
 * source chip) must agree on these, so the list lives in one place.
 */
export const FETCH_FAILURE_PREFIXES = [
	'Failed to fetch',
	'Research sub-agent failed',
	'Paywalled:'
] as const;

/** True when a tool result string is a known fetch/research failure. */
export function isFetchFailureResult(result: string | undefined): boolean {
	return !!result && FETCH_FAILURE_PREFIXES.some((p) => result.startsWith(p));
}

/**
 * True when a tool result string reports a failure, across every error
 * shape the tools emit: the `{"error": ...}` JSON envelope from
 * `toolError()`, the `Error:` prefix (sandbox runs, ad-hoc errors), lint
 * failures, and the fetch/research failure prefixes. The step UI uses
 * this to decide check-mark vs ✕ — keep it in sync when introducing a
 * new error shape (better: don't introduce new shapes).
 */
export function isToolErrorResult(result: string | undefined): boolean {
	if (!result) return false;
	const r = result.trimStart();
	return (
		r.startsWith('{"error"') ||
		r.startsWith('Error:') ||
		r.startsWith('Lint failed') ||
		isFetchFailureResult(r)
	);
}

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

/**
 * Format a tool error as `<command> failed: <reason>`. Pulls `e.message`
 * when available so DOMException / Error instances surface a clean
 * string instead of `[object Object]`. The result is the JSON-encoded
 * error envelope the model expects.
 */
export function toolInvokeError(command: string, e: unknown): string {
	return toolError(`${command} failed: ${errMessage(e)}`);
}

/**
 * Run an internal LLM call (used by `research_url`, `email_summarize_message`)
 * with the user-configured sampling params. Returns the assistant's content,
 * trimmed, with any `<think>…</think>` reasoning block removed. Callers decide
 * what to do with an empty string. The optional `signal` propagates user aborts.
 *
 * Thinking is forced OFF for sub-agents regardless of the global toggle. These
 * are single-shot extraction/summarization tasks with a fixed token budget —
 * reasoning here is pure waste: it burns the whole `maxTokens` on a `<think>`
 * block (truncating the actual findings before they're emitted) and, because
 * the combined content ships back verbatim as the tool result, dumps the raw
 * chain-of-thought into the orchestrator's context. Disabling it makes the
 * sub-agent answer directly and keeps the returned findings compact.
 */
export async function runSubAgent(
	messages: ChatMessage[],
	maxTokens: number,
	signal?: AbortSignal
): Promise<string> {
	// Sub-agent calls always run against the global Settings backend (they
	// carry no per-request override), so resolve the global descriptor here.
	const descriptor = resolveBackendDescriptor();
	const sampling = getSamplingParams(descriptor);
	const response = await chatCompletion(
		{
			messages,
			...sampling,
			max_tokens: maxTokens,
			// Force thinking off (second arg) rather than inheriting the global setting.
			chat_template_kwargs: getChatTemplateKwargs(descriptor, false)
		},
		signal
	);
	// Defensively strip any reasoning block: some models/backends emit an inline
	// <think>…</think> even with the template kwarg set, and the API layer also
	// packs a separate reasoning_content field into one. Either way the caller
	// wants only the findings.
	return stripThinkBlocks(response.content).trim();
}

/** Remove `<think>…</think>` reasoning blocks (closed or trailing-open) from a
 *  sub-agent response so only the answer text remains. */
function stripThinkBlocks(content: string | null | undefined): string {
	if (!content) return '';
	return content
		.replace(/<think>[\s\S]*?<\/think>/g, '') // closed blocks
		.replace(/<think>[\s\S]*$/, ''); // a truncated, never-closed block at the end
}

/**
 * Default a scheme-less URL to https. Models copy URLs the way users
 * write them — `example.com/page`, `www.nytimes.com/...` — which
 * `url::Url::parse` on the Rust side rejects as "Invalid URL". Only
 * strings that plausibly start with a hostname are touched; anything
 * already carrying a scheme (or not URL-shaped) passes through for the
 * backend to reject with its normal error.
 */
export function ensureUrlScheme(url: string): string {
	if (typeof url !== 'string') return url;
	const trimmed = url.trim();
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed; // has a scheme
	if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(?=[/:?#]|$)/i.test(trimmed)) return `https://${trimmed}`;
	return trimmed;
}

/**
 * Invoke the Rust-side `proxy_fetch` command with the standard payload
 * (url + caller + current proxy settings). Caller identifies the
 * originating tool for the proxy state's per-call accounting.
 */
export async function proxyFetch(url: string, caller: string): Promise<string> {
	return invoke<string>('proxy_fetch', {
		url: ensureUrlScheme(url),
		caller,
		proxy: getSettings().proxy
	});
}
