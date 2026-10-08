/**
 * Naming a Code session: one small model call after its first real turn,
 * with the first message itself as the fallback.
 *
 * The call goes to the session's own backend (Settings when it has none) and
 * queues for an inference slot like a turn, so it waits behind running turns
 * instead of racing them. No tools, a few tokens, reasoning off.
 */

import { chatCompletion, type BackendOverride, type ChatMessage } from '#lib/api.ts';
import { withInferenceSlot } from '#lib/agent/inferenceQueue.svelte.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { stripThinkBlocks } from '#lib/markdown.ts';
import {
	getChatTemplateKwargs,
	getOpenRouterReasoningParam,
	getSamplingParams
} from '#lib/stores/settings.ts';
import { logDebug } from '#lib/debug-log.ts';
import { errMessage } from '#lib/utils/error.ts';

/** Longest title, generated or taken from the message. */
export const TITLE_MAX = 60;
/** Room for six words, with a little to spare. */
const TITLE_TOKENS = 48;
/** How much of the first message the model is shown. */
const MESSAGE_MAX = 2000;

const SYSTEM_PROMPT =
	'You name coding sessions. Reply with a title of 3 to 6 plain words saying what the ' +
	'request is about. No quotes, no trailing period, no preamble: only the title.';

/** True when a message is a slash command (`/init`), which never names a session. */
export function isSlashCommand(text: string): boolean {
	return text.trim().startsWith('/');
}

/** A title from the first message: one line, at most 60 characters. */
export function titleFromMessage(text: string): string {
	return text.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trimEnd();
}

/**
 * The model's reply as a title: reasoning, quotes, a `Title:` label and a
 * trailing period removed, first line only, at most 60 characters. Empty when
 * nothing is left.
 */
export function cleanTitle(reply: string | null | undefined): string {
	const line =
		stripThinkBlocks(reply)
			.split('\n')
			.map((l) => l.trim())
			.find((l) => l !== '') ?? '';
	const t = line
		.replace(/^(session\s+)?title\s*:\s*/i, '')
		.replace(/["“”`*]/g, '')
		.replace(/^['‘’]+|['‘’]+$/g, '')
		.replace(/[.。]+$/, '')
		.replace(/\s+/g, ' ')
		.trim();
	return t.slice(0, TITLE_MAX).trimEnd();
}

/** The messages the naming call sends. */
export function titleRequest(message: string): ChatMessage[] {
	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{
			role: 'user',
			content: `Title this coding session. Its first request:\n\n${message.slice(0, MESSAGE_MAX)}`
		}
	];
}

/** Ask the model for a title. Throws when the call fails; empty when the reply is. */
export async function generateTitle(
	message: string,
	backend: BackendOverride | null
): Promise<string> {
	const override = backend ?? undefined;
	const descriptor = resolveBackendDescriptor(override);
	const reasoning = getOpenRouterReasoningParam(descriptor, false);
	const response = await withInferenceSlot({ consumer: 'code', backend: override }, () =>
		chatCompletion({
			messages: titleRequest(message),
			backend: override,
			...getSamplingParams(descriptor),
			max_tokens: TITLE_TOKENS,
			chat_template_kwargs: getChatTemplateKwargs(descriptor, false),
			...(reasoning ? { reasoning } : {})
		})
	);
	return cleanTitle(response.content);
}

/** A title for a session whose first real message is `message`. Never throws. */
export async function nameSession(
	message: string,
	backend: BackendOverride | null
): Promise<string> {
	try {
		const title = await generateTitle(message, backend);
		if (title) return title;
		logDebug('code', 'naming call came back empty');
	} catch (e) {
		logDebug('code', 'naming call failed', { error: errMessage(e) });
	}
	return titleFromMessage(message);
}
