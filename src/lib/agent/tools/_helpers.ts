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
 * Format a tool error as `<command> failed: <reason>`. Pulls `e.message`
 * when available so DOMException / Error instances surface a clean
 * string instead of `[object Object]`. The result is the JSON-encoded
 * error envelope the model expects.
 */
export function toolInvokeError(command: string, e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	return toolError(`${command} failed: ${msg}`);
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
