/**
 * Camera alerts' room checks: compare a camera's room with the reference the
 * user set (This is normal), about a minute after activity there settles and
 * once an hour otherwise, to catch furniture moved, something gone or new,
 * or smoke.
 *
 * - The picture is taken at the camera's home (`camera_room_shot` turns it
 *   there, unless someone turned it in the last five minutes: then the check
 *   tries again five minutes later, once).
 * - A picture almost the same as a reference under a day old ends there,
 *   with no model call. Otherwise the model compares the two.
 * - A changed room is logged as a `room` entry with its judgement, which the
 *   alert emails act on like any other. A normal check with nobody in view
 *   becomes the new reference, so slow changes don't keep alerting.
 */
import { invoke } from '@tauri-apps/api/core';
import { chatCompletion, type ChatMessage } from '#lib/api.ts';
import { withInferenceSlot } from '#lib/agent/inferenceQueue.svelte.ts';
import { parseModelJson } from '#lib/agent/jobs/cardResult.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import type { AlertLevel } from '#lib/ipc/gen/AlertLevel.ts';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';
import type { RoomShot } from '#lib/ipc/gen/RoomShot.ts';
import { stripThinkBlocks } from '#lib/markdown.ts';
import {
	getChatTemplateKwargs,
	getOpenRouterReasoningParam,
	getSamplingParams,
	getSettings
} from '#lib/stores/settings.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import { cameraDataAllowed } from '#lib/camera/trust.ts';
import { emitCannotJudge, emitJudged, onJudged } from '#lib/camera/alertEvents.ts';
import { JUDGE_TOKENS, MAX_REASON } from '#lib/camera/judge.ts';
import { logDebug } from '#lib/debugLog.ts';
import { errMessage } from '#lib/utils/error.ts';

/** Similarity at or above which the room is unchanged, with no model call. */
export const ROOM_SAME = 0.995;
/** A check this long after an entry ends, once the room has settled. */
export const SETTLE_MS = 60_000;
/** A check at least this often otherwise. */
export const HOURLY_MS = 3_600_000;
/** A reference older than this is checked by the model even when the picture matches. */
export const REFERENCE_FRESH_MS = 24 * 3_600_000;
/** The wait before one retry when someone is aiming the camera. */
export const BUSY_RETRY_MS = 5 * 60_000;
/** Urgent entries this recent are told to the room check. */
const RECENT_URGENT_MS = 30 * 60_000;
const TICK_MS = 60_000;

/** What the model found comparing the room with its reference. */
export interface RoomJudgement {
	people: number;
	changes: string[];
	level: AlertLevel;
	reason: string;
}

const ROOM_INSTRUCTIONS = `You check a room for its owner. The first picture is the room as it normally looks; the second is now, from the same camera. Never judge who anyone is.

Changes in light, shadows, screens, curtains, pets and small objects don't count.
Urgent: smoke, flames or a fire glow; a door or window forced; or valuables gone right after an urgent entry listed below; or a watch rule below that matches.
Unusual: large furniture moved, a large object missing, or a new large object.
Normal: anything else.

Answer with JSON only:
{"people": <number of people in the second picture>, "changes": ["<each change that counts, a few words each>"], "level": "normal" | "unusual" | "urgent", "reason": "<one short sentence>"}`;

/** The request comparing the room now with its reference. */
export function roomJudgeMessages(
	reference: string,
	now: string,
	camera: CameraConfig,
	recentUrgent: string[]
): ChatMessage[] {
	const lines = [ROOM_INSTRUCTIONS, '', `Camera: ${camera.name}.`];
	if (camera.note?.trim()) lines.push(`About this camera: ${camera.note.trim()}`);
	if (camera.alerts.watchRules.length) {
		lines.push('Watch rules:', ...camera.alerts.watchRules.map((r, i) => `${i + 1}. ${r}`));
	}
	if (recentUrgent.length) {
		lines.push('Urgent entries in the last 30 minutes:', ...recentUrgent.map((r) => `- ${r}`));
	}
	return [
		{
			role: 'user',
			content: [
				{ type: 'image_url', image_url: { url: reference } },
				{ type: 'image_url', image_url: { url: now } },
				{ type: 'text', text: lines.join('\n') }
			]
		}
	];
}

/** The model's answer; a reply that isn't the JSON asked for is Normal with no changes. */
export function parseRoomJudgement(content: string | null | undefined): RoomJudgement {
	try {
		const o = parseModelJson(stripThinkBlocks(content)) as Record<string, unknown>;
		const level: AlertLevel =
			o.level === 'urgent' || o.level === 'unusual' || o.level === 'normal' ? o.level : 'normal';
		const changes = Array.isArray(o.changes)
			? o.changes
					.filter((c): c is string => typeof c === 'string' && !!c.trim())
					.map((c) => c.trim().slice(0, 120))
					.slice(0, 8)
			: [];
		return {
			people:
				typeof o.people === 'number' && Number.isFinite(o.people)
					? Math.max(0, Math.round(o.people))
					: 0,
			changes,
			level,
			reason:
				typeof o.reason === 'string'
					? o.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON)
					: ''
		};
	} catch {
		return { people: 0, changes: [], level: 'normal', reason: '' };
	}
}

/** Whether `at` is inside the camera's watcher hours. */
export function inActiveHours(camera: CameraConfig, at: Date): boolean {
	const hours = camera.watcher.activeHours;
	if (!hours) return true;
	const mins = (t: string) => {
		const [h, m] = t.split(':').map(Number);
		return h * 60 + (m || 0);
	};
	const now = at.getHours() * 60 + at.getMinutes();
	const [start, end] = [mins(hours.start), mins(hours.end)];
	return start <= end ? now >= start && now < end : now >= start || now < end;
}

/** The cameras room checks run for: Alerts on, Allow, the log on. */
function checkedCameras(): CameraConfig[] {
	return getSettings().cameras.filter(
		(c) => c.alerts.enabled && c.permission === 'allow' && c.watcher.enabled
	);
}

/** Why a check ended; for tests and the debug log. */
export type RoomOutcome =
	| 'busy'
	| 'no-reference'
	| 'first-for-light'
	| 'unchanged'
	| 'no-model'
	| 'refreshed'
	| 'people'
	| 'repeat'
	| 'logged';

async function recentUrgent(camera: CameraConfig, now: number): Promise<string[]> {
	try {
		const events = await invoke<CameraEvent[]>('camera_events_list', {
			cameraId: camera.id,
			since: now - RECENT_URGENT_MS,
			limit: 20
		});
		return events
			.filter((e) => e.alertLevel === 'urgent' && e.alertReason)
			.map((e) => e.alertReason);
	} catch {
		return [];
	}
}

/** Ask the model to compare the room now with its reference; undefined when no model may. */
function compareRoom(
	camera: CameraConfig,
	reference: string,
	now: string,
	urgent: string[]
): Promise<string | undefined> {
	return withInferenceSlot({ consumer: 'camera', priority: 'prompt' }, async () => {
		const d = resolveBackendDescriptor();
		if (!cameraDataAllowed(d) || !d.vision) return undefined;
		const reasoning = getOpenRouterReasoningParam(d, false);
		const response = await chatCompletion({
			messages: roomJudgeMessages(reference, now, camera, urgent),
			...getSamplingParams(d),
			temperature: 0,
			max_tokens: JUDGE_TOKENS,
			chat_template_kwargs: getChatTemplateKwargs(d, false),
			...(reasoning ? { reasoning } : {})
		});
		return response.content ?? '';
	});
}

/** What a judged room check does: refresh the reference, or log a room entry. */
async function actOn(camera: CameraConfig, jpeg: string, j: RoomJudgement): Promise<RoomOutcome> {
	if (j.level === 'normal') {
		if (j.people > 0) return 'people';
		if (j.changes.length > 0) return 'unchanged';
		await invoke('camera_reference_set', { cameraId: camera.id, jpeg });
		lastLogged.delete(camera.id);
		return 'refreshed';
	}
	const event = await invoke<CameraEvent>('camera_room_event_add', {
		cameraId: camera.id,
		jpeg,
		caption: `Room check: ${j.changes.join('; ') || 'the room has changed'}.`,
		level: j.level,
		reason: j.reason || (j.changes[0] ?? 'The room has changed.')
	});
	lastLogged.set(camera.id, jpeg);
	emitJudged(event, camera);
	return 'logged';
}

/** Run one room check on `camera` now. */
export async function checkRoom(camera: CameraConfig, now = Date.now()): Promise<RoomOutcome> {
	const shot = await invoke<RoomShot>('camera_room_shot', {
		config: camera,
		overrides: videoOverrides(),
		last: lastLogged.get(camera.id) ?? null
	});
	if (shot.busy) return 'busy';
	if (!shot.hasReferences) return 'no-reference';
	// The change already logged, still there: not logged again.
	if (shot.similarityToLast !== null && shot.similarityToLast >= ROOM_SAME) return 'repeat';
	if (shot.similarity === null || !shot.reference) {
		// The first check in this light: it becomes that light's reference.
		await invoke('camera_reference_set', { cameraId: camera.id, jpeg: shot.jpeg });
		return 'first-for-light';
	}
	const fresh = shot.referenceAt !== null && now - shot.referenceAt < REFERENCE_FRESH_MS;
	if (shot.similarity >= ROOM_SAME) lastLogged.delete(camera.id);
	if (shot.similarity >= ROOM_SAME && fresh) return 'unchanged';

	const reference = shot.reference;
	const urgent = await recentUrgent(camera, now);
	const reply = await compareRoom(camera, reference, shot.jpeg, urgent);
	if (reply === undefined) {
		emitCannotJudge(camera.id);
		return 'no-model';
	}
	return actOn(camera, shot.jpeg, parseRoomJudgement(reply));
}

const lastCheck = new Map<string, number>();
/** The picture of each camera's last logged change, until the room matches its reference again. */
const lastLogged = new Map<string, string>();
/** Cameras asked for a check while one ran: it runs again when that one ends. */
const rerun = new Set<string>();
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Set<string>();
let tick: ReturnType<typeof setInterval> | null = null;
let stopJudged: (() => void) | null = null;

/** Run a check on a camera unless one is running; retry once when busy. */
export async function runCheck(cameraId: string, retry = true): Promise<RoomOutcome | null> {
	const camera = checkedCameras().find((c) => c.id === cameraId);
	if (!camera) return null;
	if (running.has(cameraId)) {
		rerun.add(cameraId);
		return null;
	}
	if (!inActiveHours(camera, new Date())) return null;
	running.add(cameraId);
	try {
		const outcome = await checkRoom(camera);
		lastCheck.set(cameraId, Date.now());
		logDebug('camera', 'room check', { camera: camera.name, outcome });
		if (outcome === 'busy' && retry) {
			settleTimers.set(
				cameraId,
				setTimeout(() => {
					settleTimers.delete(cameraId);
					void runCheck(cameraId, false);
				}, BUSY_RETRY_MS)
			);
		}
		return outcome;
	} catch (e) {
		lastCheck.set(cameraId, Date.now());
		console.warn('Room check:', errMessage(e));
		return null;
	} finally {
		running.delete(cameraId);
		if (rerun.delete(cameraId)) void runCheck(cameraId);
	}
}

/** Check a camera `SETTLE_MS` after an entry ends; a later entry pushes it back. */
export function scheduleAfter(event: CameraEvent, now = Date.now()): void {
	if (event.trigger === 'room') return;
	const old = settleTimers.get(event.cameraId);
	if (old) clearTimeout(old);
	const wait = Math.max(0, event.endedAt + SETTLE_MS - now);
	settleTimers.set(
		event.cameraId,
		setTimeout(() => {
			settleTimers.delete(event.cameraId);
			void runCheck(event.cameraId);
		}, wait)
	);
}

/** Every camera due its hourly check. */
export function runDueChecks(now = Date.now()): void {
	for (const camera of checkedCameras()) {
		const last = lastCheck.get(camera.id);
		if (last === undefined) {
			// The first hour starts when room checks do.
			lastCheck.set(camera.id, now);
			continue;
		}
		if (now - last >= HOURLY_MS && !settleTimers.has(camera.id)) void runCheck(camera.id);
	}
}

/** Start room checks for every Alerts-on camera. Idempotent. */
export function startRoomChecks(): void {
	if (tick) return;
	stopJudged = onJudged((event) => scheduleAfter(event));
	tick = setInterval(() => runDueChecks(), TICK_MS);
	runDueChecks();
}

/** For tests: stop and forget everything. */
export function _resetRoomChecksForTests(): void {
	if (tick) clearInterval(tick);
	tick = null;
	stopJudged?.();
	stopJudged = null;
	for (const t of settleTimers.values()) clearTimeout(t);
	settleTimers.clear();
	lastCheck.clear();
	lastLogged.clear();
	rerun.clear();
	running.clear();
}
