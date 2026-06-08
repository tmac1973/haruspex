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
 * with the user-configured sampling params and chat template kwargs.
 * Returns the assistant's content, trimmed. Callers decide what to do
 * with an empty string. The optional `signal` propagates user aborts.
 */
export async function runSubAgent(
	messages: ChatMessage[],
	maxTokens: number,
	signal?: AbortSignal
): Promise<string> {
	const sampling = getSamplingParams();
	const response = await chatCompletion(
		{
			messages,
			temperature: sampling.temperature,
			top_p: sampling.top_p,
			top_k: sampling.top_k,
			presence_penalty: sampling.presence_penalty,
			max_tokens: maxTokens,
			chat_template_kwargs: getChatTemplateKwargs()
		},
		signal
	);
	return response.content?.trim() ?? '';
}

/**
 * Invoke the Rust-side `proxy_fetch` command with the standard payload
 * (url + caller + current proxy settings). Caller identifies the
 * originating tool for the proxy state's per-call accounting.
 */
export async function proxyFetch(url: string, caller: string): Promise<string> {
	return invoke<string>('proxy_fetch', {
		url,
		caller,
		proxy: getSettings().proxy
	});
}
