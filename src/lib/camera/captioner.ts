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
 * A camera with Alerts on (Settings → Cameras) gets a judgement with its
 * caption, in one call at `prompt` priority, so an urgent event is known as
 * soon as the current chat turn ends (`judge.ts`). Its events are taken first,
 * and wait for a model that can see rather than being skipped.
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
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import { stamp } from '#lib/camera/log.ts';
import {
	applyRules,
	isQuietAt,
	isUnreachable,
	JUDGE_TOKENS,
	judgeMessages,
	parseJudgement,
	quietHoursFor,
	type Judgement
} from '#lib/camera/judge.ts';
import { emitCannotJudge, emitJudged } from '#lib/camera/alertEvents.ts';

export const CAPTION_PROMPT =
	"Describe this camera frame in one sentence: who or what is in it and what they are doing. Mention people and animals; if there are none, say what the scene shows. Don't guess identities.";
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
	const camera = alertsCamera(event);
	if (camera) return judgeOne(event, camera);
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

/** The event's camera when it has Alerts on; null otherwise. */
function alertsCamera(event: CameraEvent): CameraConfig | null {
	const camera = getSettings().cameras.find((c) => c.id === event.cameraId);
	return camera?.alerts.enabled ? camera : null;
}

async function saveJudgement(event: CameraEvent, camera: CameraConfig, j: Judgement) {
	const caption = j.caption || null;
	await invoke('camera_event_set_judgement', {
		id: event.id,
		caption,
		level: j.level,
		reason: j.reason
	});
	emitJudged(
		{
			...event,
			caption,
			captionStatus: caption ? 'done' : 'skipped',
			alertLevel: j.level,
			alertReason: j.reason
		},
		camera
	);
}

/**
 * Caption and judge one event of an Alerts-on camera. With no model that may
 * see its frame, or one that can't be reached, it stays pending and the pass
 * stops (`not-allowed`); a reply that fails `MAX_ATTEMPTS` times is skipped.
 */
async function judgeOne(event: CameraEvent, camera: CameraConfig): Promise<Stop | null> {
	const descriptor = resolveBackendDescriptor();
	if (!cameraDataAllowed(descriptor) || (!descriptor.vision && event.hasThumb)) {
		emitCannotJudge(camera.id);
		return 'not-allowed';
	}
	const at = new Date(event.startedAt);
	try {
		const quietHour = isQuietAt(await quietHoursFor(camera), at);
		const rules = {
			transcript: event.transcript,
			usualPeople: camera.alerts.usualPeople,
			quietHour
		};
		if (!event.hasThumb) {
			// Nothing to look at: only what was heard can flag it.
			const j = applyRules(
				{ caption: '', people: 0, level: 'normal', reason: '', rule: null },
				rules
			);
			await saveJudgement(event, camera, j);
			return null;
		}
		const thumb = await invoke<string>('camera_event_thumb', { id: event.id });
		const reply = await withInferenceSlot({ consumer: 'camera', priority: 'prompt' }, async () => {
			const now = resolveBackendDescriptor();
			if (!cameraDataAllowed(now) || !now.vision) return undefined;
			const reasoning = getOpenRouterReasoningParam(now, false);
			const response = await chatCompletion({
				messages: judgeMessages(event, thumb, camera, { time: stamp(at), quietHour }),
				...getSamplingParams(now),
				temperature: 0,
				max_tokens: JUDGE_TOKENS,
				chat_template_kwargs: getChatTemplateKwargs(now, false),
				...(reasoning ? { reasoning } : {})
			});
			return response.content ?? '';
		});
		if (reply === undefined) {
			emitCannotJudge(camera.id);
			return 'not-allowed';
		}
		await saveJudgement(event, camera, applyRules(parseJudgement(reply), rules));
		attempts.delete(event.id);
		return null;
	} catch (e) {
		if (isUnreachable(e)) {
			logDebug('camera', 'judging an event waits for the model', { id: event.id });
			emitCannotJudge(camera.id);
			return 'not-allowed';
		}
		const tries = (attempts.get(event.id) ?? 0) + 1;
		logDebug('camera', 'judging an event failed', { id: event.id, tries, error: errMessage(e) });
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

/** How soon a pass runs again after judging had to wait for the model. */
export const JUDGE_RETRY_MS = 30_000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Look again soon: the model may be back (loaded, restarted, or switched to one that sees). */
function retrySoon(): void {
	if (retryTimer) return;
	retryTimer = setTimeout(() => {
		retryTimer = null;
		void captionPending().catch((e) => console.warn('Camera captions:', errMessage(e)));
	}, JUDGE_RETRY_MS);
}

async function drain(): Promise<void> {
	// Alerts-on cameras whose events wait for a model this pass: the other
	// cameras' events still get captions.
	const waiting = new Set<string>();
	for (;;) {
		if (!cameraDataAllowed(resolveBackendDescriptor())) return;
		const events = await invoke<CameraEvent[]>('camera_events_pending', { limit: BATCH });
		const ready = events.filter((e) => !waiting.has(e.cameraId));
		if (ready.length === 0) {
			if (waiting.size) retrySoon();
			return;
		}
		// Alerts-on cameras' events first; each group keeps its oldest-first order.
		const judged = ready.filter((e) => alertsCamera(e));
		const rest = ready.filter((e) => !alertsCamera(e));
		for (const event of [...judged, ...rest]) {
			const stop = await captionOne(event);
			if (stop === 'not-allowed' && alertsCamera(event)) {
				waiting.add(event.cameraId);
				continue;
			}
			if (stop) return;
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
	if (retryTimer) clearTimeout(retryTimer);
	retryTimer = null;
}
