/**
 * The ambient camera log as text: reading the times a model gives
 * (`parseLogTime`) and writing entries as lines it can read
 * (`renderCameraLog`). Used by the `camera_log` tool and Settings → Cameras.
 */

import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';
import { getSettings } from '#lib/stores/settings.ts';

/** Local date and time, to the second: "2026-11-12 14:03:22". */
export function stamp(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Entries `camera_log` returns unless asked for more or fewer. */
export const DEFAULT_LOG_LIMIT = 20;
/** The most it returns in one call. */
export const MAX_LOG_LIMIT = 100;
const HOUR = 3_600_000;
const UNIT_MS: Record<string, number> = { minute: 60_000, hour: HOUR, day: 24 * HOUR };

function startOfDay(d: Date): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "last 3 hours", "past day" and the like, as epoch ms; null when it isn't one. */
function relativeTime(text: string, now: Date): number | null {
	const last = /^(?:the\s+)?(?:last|past)\s+(\d+(?:\.\d+)?\s+)?(minute|hour|day)s?$/.exec(text);
	if (!last) return null;
	const n = last[1] ? Number(last[1]) : 1;
	return now.getTime() - n * UNIT_MS[last[2]];
}

/**
 * A `since` or `until` the model gave, as epoch ms: an ISO time, "today",
 * "yesterday", "last hour" or "last N minutes / hours / days". `until` of a
 * day is that day's end. Undefined when none was given.
 */
export function parseLogTime(
	raw: unknown,
	edge: 'since' | 'until',
	now = new Date()
): number | undefined | { error: string } {
	if (raw === undefined || raw === null) return undefined;
	const text = String(raw).trim().toLowerCase();
	if (!text) return undefined;
	const today = startOfDay(now);
	if (text === 'today') return edge === 'since' ? today : now.getTime();
	if (text === 'yesterday') {
		const start = startOfDay(new Date(today - 12 * HOUR));
		return edge === 'since' ? start : today - 1;
	}
	if (text === 'now') return now.getTime();
	const ago = relativeTime(text, now);
	if (ago !== null) return ago;
	const iso = String(raw).trim();
	// A bare date reads as local midnight, not UTC's.
	const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00` : iso;
	const ms = Date.parse(date);
	if (Number.isNaN(ms)) {
		return {
			error: `Can't read ${edge} "${String(raw)}". Use an ISO time (2026-11-12T14:00), "today", "yesterday" or "last 3 hours".`
		};
	}
	if (edge === 'until' && date !== iso) return ms + 24 * HOUR - 1;
	return ms;
}

/** The number of entries the model asked for, 1 to `MAX_LOG_LIMIT`. */
export function logLimit(raw: unknown): number {
	const n = typeof raw === 'number' ? raw : Number(raw);
	if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) {
		return DEFAULT_LOG_LIMIT;
	}
	return Math.min(Math.max(Math.round(n), 1), MAX_LOG_LIMIT);
}

const TRIGGER_TEXT: Record<string, string> = {
	motion: 'motion',
	sound: 'sound',
	both: 'motion and sound'
};

/** Text ending in a full stop, unless it already ends a sentence. */
function sentence(text: string): string {
	const t = text.trim();
	return /[.!?…"'”)]$/.test(t) ? t : `${t}.`;
}

/**
 * One log entry as a line of text: local time, camera, trigger, the caption
 * (or why there is none) and what was said.
 * "2026-11-12 14:03:22 · Kitchen · motion — Seen: A man puts a box down. Heard: "Parcel for you.""
 */
export function renderCameraLogEntry(event: CameraEvent, camera: string): string {
	const seen =
		event.captionStatus === 'done' && event.caption
			? `Seen: ${sentence(event.caption)}`
			: event.captionStatus === 'pending'
				? 'Seen: caption pending.'
				: 'Seen: no caption.';
	const words = event.transcript.trim();
	const heard = words ? ` Heard: "${words}"` : '';
	const trigger = TRIGGER_TEXT[event.trigger] ?? event.trigger;
	return `${stamp(new Date(event.startedAt))} · ${camera} · ${trigger} — ${seen}${heard}`;
}

/** Log entries, newest first, one per line; camera ids named from Settings → Cameras. */
export function renderCameraLog(
	events: readonly CameraEvent[],
	cameras: readonly CameraConfig[] = getSettings().cameras
): string {
	const nameOf = (id: string) => cameras.find((c) => c.id === id)?.name ?? id;
	return events.map((e) => renderCameraLogEntry(e, nameOf(e.cameraId))).join('\n');
}
