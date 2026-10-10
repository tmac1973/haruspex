/**
 * Summarising a conversation too long for one request: the chunked, rolling
 * summary behind Chat's compaction (`agent/compaction.ts`), guest chats
 * (`remote/conversation.ts`) and Code sessions (`code/compaction.ts`). Each
 * caller brings its own prompt.
 *
 * Every request is sized to the window: the summary so far plus as much of
 * what is left as fits, so a conversation of any length can be summarised.
 */

import { chatCompletion, type BackendOverride } from '#lib/api.ts';
import {
	TOKEN_BYTES_RATIO,
	estimateMessagesTokens,
	estimateTokens,
	getTokenCalibration
} from '#lib/agent/context-budget.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { stripThinkBlocks } from '#lib/markdown.ts';
import { truncateCapturedOutput } from '#lib/shell/truncate.ts';
import { getChatTemplateKwargs } from '#lib/stores/settings.ts';

/** The summary's own length: a sixteenth of the window, up to this. */
const SUMMARY_MAX_TOKENS = 4096;
const SUMMARY_MIN_TOKENS = 512;

/** The summary's reply budget for a window. */
export function summaryMaxTokens(contextSize: number): number {
	return Math.max(SUMMARY_MIN_TOKENS, Math.min(SUMMARY_MAX_TOKENS, Math.floor(contextSize / 16)));
}

function summaryRequest(previous: string | null, instructions: string, chunk: string): string {
	const parts: string[] = [];
	if (previous) {
		parts.push(
			`The summary so far:\n\n${previous}\n\nUpdate it with what follows, keeping what still matters from it.`
		);
	}
	if (instructions) parts.push(`The user asks you to keep: ${instructions}`);
	parts.push(`To summarise:\n\n${chunk}`);
	return parts.join('\n\n');
}

/**
 * Roll a summary forward over `parts`, in as few chunks as fit one request
 * each: every call carries the summary so far and the next chunk. A single
 * part too big for a request on its own is clipped to head and tail. Throws
 * when a call fails or comes back empty, so the caller can fall back.
 */
export async function summarizeInChunks(opts: {
	/** The system prompt: what to summarise and how. */
	prompt: string;
	/** The summary so far, carried into the first request. */
	previous: string | null;
	/** What to summarise, in order: turns or messages, as text. */
	parts: string[];
	backend: BackendOverride | null;
	contextSize: number;
	signal?: AbortSignal;
	/** What the user asked to keep. */
	instructions?: string;
}): Promise<string> {
	const descriptor = resolveBackendDescriptor(opts.backend ?? undefined);
	const maxTokens = summaryMaxTokens(opts.contextSize);
	const instructions = opts.instructions?.trim() ?? '';
	// The request's room, in the raw estimate the calibration scales.
	const room = Math.floor((opts.contextSize - maxTokens) / getTokenCalibration());
	let summary = opts.previous;
	let next = 0;
	while (next < opts.parts.length) {
		const fixed =
			estimateMessagesTokens([
				{ role: 'system', content: opts.prompt },
				{ role: 'user', content: summaryRequest(summary, instructions, '') }
			]) + 16;
		// Headroom for the joins and a clipped part's truncation marker.
		const budget = Math.max(256, room - fixed - 64);
		const chunk: string[] = [];
		let used = 0;
		while (next < opts.parts.length) {
			const part = opts.parts[next];
			const cost = estimateTokens(part) + 2;
			if (chunk.length > 0 && used + cost > budget) break;
			chunk.push(
				cost > budget
					? truncateCapturedOutput(part, Math.floor(budget * TOKEN_BYTES_RATIO)).text
					: part
			);
			used += cost;
			next++;
		}
		const response = await chatCompletion(
			{
				messages: [
					{ role: 'system', content: opts.prompt },
					{ role: 'user', content: summaryRequest(summary, instructions, chunk.join('\n\n')) }
				],
				max_tokens: maxTokens,
				temperature: 0.3,
				// Reasoning would spend the reply budget before the summary.
				chat_template_kwargs: getChatTemplateKwargs(descriptor, false),
				backend: opts.backend ?? undefined
			},
			opts.signal
		);
		const text = stripThinkBlocks(response.content ?? '').trim();
		if (!text) throw new Error('The model returned an empty summary.');
		summary = text;
	}
	if (!summary) throw new Error('There was nothing to summarise.');
	return summary;
}
