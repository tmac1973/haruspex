import { describe, it, expect } from 'vitest';
import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import {
	logLimit,
	parseLogTime,
	renderCameraLog,
	renderCameraLogEntry,
	stamp
} from '#lib/camera/log.ts';

// Thursday 12 November 2026, 15:30 local time.
const NOW = new Date(2026, 10, 12, 15, 30, 0);
const local = (...parts: number[]) =>
	new Date(parts[0], parts[1], parts[2], parts[3] ?? 0, parts[4] ?? 0).getTime();

describe('parseLogTime', () => {
	it('reads nothing as no bound', () => {
		expect(parseLogTime(undefined, 'since', NOW)).toBeUndefined();
		expect(parseLogTime(null, 'until', NOW)).toBeUndefined();
		expect(parseLogTime('  ', 'since', NOW)).toBeUndefined();
	});

	it('reads today and yesterday as whole local days', () => {
		expect(parseLogTime('today', 'since', NOW)).toBe(local(2026, 10, 12));
		expect(parseLogTime('Today', 'until', NOW)).toBe(NOW.getTime());
		expect(parseLogTime('yesterday', 'since', NOW)).toBe(local(2026, 10, 11));
		expect(parseLogTime('yesterday', 'until', NOW)).toBe(local(2026, 10, 12) - 1);
	});

	it('reads "last N hours", minutes and days', () => {
		const t = NOW.getTime();
		expect(parseLogTime('last 3 hours', 'since', NOW)).toBe(t - 3 * 3_600_000);
		expect(parseLogTime('last hour', 'since', NOW)).toBe(t - 3_600_000);
		expect(parseLogTime('past 30 minutes', 'since', NOW)).toBe(t - 30 * 60_000);
		expect(parseLogTime('the last 2 days', 'since', NOW)).toBe(t - 2 * 86_400_000);
	});

	it('reads ISO times, and a bare date as that local day', () => {
		expect(parseLogTime('2026-11-12T14:00', 'since', NOW)).toBe(local(2026, 10, 12, 14));
		expect(parseLogTime('2026-11-12T14:00:00Z', 'since', NOW)).toBe(Date.UTC(2026, 10, 12, 14));
		expect(parseLogTime('2026-11-10', 'since', NOW)).toBe(local(2026, 10, 10));
		expect(parseLogTime('2026-11-10', 'until', NOW)).toBe(local(2026, 10, 11) - 1);
	});

	it('says what it could not read', () => {
		const out = parseLogTime('around teatime', 'since', NOW);
		expect(out).toEqual({ error: expect.stringContaining('"around teatime"') });
	});
});

describe('logLimit', () => {
	it('defaults to 20 and keeps to 1–100', () => {
		expect(logLimit(undefined)).toBe(20);
		expect(logLimit('x')).toBe(20);
		expect(logLimit(0)).toBe(1);
		expect(logLimit(500)).toBe(100);
		expect(logLimit('7')).toBe(7);
	});
});

describe('renderCameraLog', () => {
	const at = local(2026, 10, 12, 14, 3);
	const entry = (over: Partial<CameraEvent> = {}): CameraEvent => ({
		id: 1,
		cameraId: 'cam-1',
		startedAt: at,
		endedAt: at + 4_000,
		trigger: 'both',
		levelDb: -28,
		transcript: ' Parcel for you. ',
		caption: 'A man puts a box by the door.',
		captionStatus: 'done',
		hasThumb: true,
		alertLevel: null,
		alertReason: '',
		dismissedAt: null,
		dismissNote: '',
		...over
	});

	it('writes one line with the time, camera, trigger, caption and words', () => {
		expect(renderCameraLogEntry(entry(), 'Porch')).toBe(
			`${stamp(new Date(at))} · Porch · motion and sound — Seen: A man puts a box by the door. Heard: "Parcel for you."`
		);
	});

	it('says when the caption is pending or missing, and leaves out silence', () => {
		const pending = renderCameraLogEntry(
			entry({ caption: null, captionStatus: 'pending', transcript: '', trigger: 'motion' }),
			'Porch'
		);
		expect(pending).toMatch(/· motion — Seen: caption pending\.$/);
		const skipped = renderCameraLogEntry(entry({ caption: null, captionStatus: 'skipped' }), 'P');
		expect(skipped).toContain('Seen: no caption. Heard:');
	});

	it('names each camera from the settings, or by id when it is gone', () => {
		const cameras = [{ id: 'cam-1', name: 'Porch' }] as CameraConfig[];
		const out = renderCameraLog([entry(), entry({ id: 2, cameraId: 'cam-9' })], cameras);
		const lines = out.split('\n');
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain('· Porch ·');
		expect(lines[1]).toContain('· cam-9 ·');
	});
});
