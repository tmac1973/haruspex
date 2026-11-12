/**
 * Captions for the ambient log: each event the watcher logs gets one sentence
 * from the model about its thumbnail, so the log can be searched by what was
 * seen as well as what was said.
 *
 * Captions go through the inference queue at background priority, so a chat
 * turn is never slowed: an event logged mid-turn is captioned after it. Only
 * a model allowed camera frames (the local one, or a server trusted in
 * Settings → Cameras) captions; with any other the events stay pending until
 * one is. A model that can't see marks them skipped.
 *
 * One event at a time, oldest first. Started once by the main window
 * (`startCaptioner`), which also runs a pass at startup for events left
 * pending last time.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { chatCompletion, type ChatMessage } from '#lib/api.ts';
import { withInferenceSlot } from '#lib/agent/inferenceQueue.svelte.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { cameraDataAllowed } from '#lib/camera/trust.ts';
import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';
import {
	getChatTemplateKwargs,
	getOpenRouterReasoningParam,
	getSamplingParams,
	getSettings
} from '#lib/stores/settings.ts';
import { stripThinkBlocks } from '#lib/markdown.ts';
import { logDebug } from '#lib/debugLog.ts';
import { errMessage } from '#lib/utils/error.ts';

export const CAPTION_PROMPT =
	"Describe what is happening in this camera frame in one sentence. Mention people, animals and anything that changed. Don't guess identities.";
/** Room for one sentence. */
export const CAPTION_TOKENS = 80;
/** Events read per batch. */
const BATCH = 20;
/** Failed calls for one event before it is skipped rather than retried. */
const MAX_ATTEMPTS = 3;

/** The request for one event's caption. */
export function captionMessages(event: CameraEvent, thumb: string): ChatMessage[] {
	const camera = getSettings().cameras.find((c) => c.id === event.cameraId)?.name;
	const said = event.transcript.trim();
	const context = [
		camera ? `Camera: ${camera}.` : '',
		said ? `What was heard: "${said}"` : ''
	].filter(Boolean);
	const text = context.length ? `${CAPTION_PROMPT}\n\n${context.join('\n')}` : CAPTION_PROMPT;
	return [
		{
			role: 'user',
			content: [
				{ type: 'image_url', image_url: { url: thumb } },
				{ type: 'text', text }
			]
		}
	];
}

/** The model's reply as one line: no think block, no line breaks. */
export function cleanCaption(content: string | null | undefined): string {
	return stripThinkBlocks(content).replace(/\s+/g, ' ').trim();
}

async function setCaption(id: number, caption: string | null): Promise<void> {
	await invoke('camera_event_set_caption', { id, caption });
}

/** Why a pass stopped before the queue was empty. */
type Stop = 'not-allowed' | 'failed';

const attempts = new Map<number, number>();

/**
 * Caption one event. A model that may not have the frame leaves it pending
 * (`not-allowed`); a failed call leaves it pending too, until it has failed
 * `MAX_ATTEMPTS` times.
 */
async function captionOne(event: CameraEvent): Promise<Stop | null> {
	const descriptor = resolveBackendDescriptor();
	if (!cameraDataAllowed(descriptor)) return 'not-allowed';
	if (!descriptor.vision || !event.hasThumb) {
		await setCaption(event.id, null);
		return null;
	}
	try {
		const thumb = await invoke<string>('camera_event_thumb', { id: event.id });
		const caption = await withInferenceSlot(
			{ consumer: 'camera', priority: 'background' },
			async () => {
				// The model may have changed while this waited its turn.
				const now = resolveBackendDescriptor();
				if (!cameraDataAllowed(now)) return undefined;
				const reasoning = getOpenRouterReasoningParam(now, false);
				const response = await chatCompletion({
					messages: captionMessages(event, thumb),
					...getSamplingParams(now),
					max_tokens: CAPTION_TOKENS,
					chat_template_kwargs: getChatTemplateKwargs(now, false),
					...(reasoning ? { reasoning } : {})
				});
				return cleanCaption(response.content);
			}
		);
		if (caption === undefined) return 'not-allowed';
		await setCaption(event.id, caption || null);
		attempts.delete(event.id);
		return null;
	} catch (e) {
		const tries = (attempts.get(event.id) ?? 0) + 1;
		logDebug('camera', 'captioning an event failed', { id: event.id, tries, error: errMessage(e) });
		if (tries < MAX_ATTEMPTS) {
			attempts.set(event.id, tries);
			return 'failed';
		}
		attempts.delete(event.id);
		await setCaption(event.id, null).catch(() => {});
		return null;
	}
}

let running = false;
let again = false;

/**
 * Caption every pending event, one at a time. A call while a pass runs makes
 * that pass look again when it ends, rather than starting a second.
 */
export async function captionPending(): Promise<void> {
	if (running) {
		again = true;
		return;
	}
	running = true;
	try {
		do {
			again = false;
			await drain();
		} while (again);
	} finally {
		running = false;
	}
}

async function drain(): Promise<void> {
	for (;;) {
		if (!cameraDataAllowed(resolveBackendDescriptor())) return;
		const events = await invoke<CameraEvent[]>('camera_events_pending', { limit: BATCH });
		if (events.length === 0) return;
		for (const event of events) {
			if (await captionOne(event)) return;
		}
	}
}

let unlisten: UnlistenFn | null = null;

/** Caption new events as they are logged, and any left pending. Idempotent. */
export async function startCaptioner(): Promise<void> {
	if (unlisten) return;
	unlisten = await listen('camera://event', () => {
		void captionPending().catch((e) => console.warn('Camera captions:', errMessage(e)));
	});
	await captionPending();
}

/** For tests: forget the listener and the failure counts. */
export function _resetCaptionerForTests(): void {
	unlisten?.();
	unlisten = null;
	running = false;
	again = false;
	attempts.clear();
}
