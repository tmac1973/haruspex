/**
 * How far a running task has got, in a few words: shared by its card and
 * the Tasks chip.
 */
import type { BackgroundTask } from '#lib/tasks/types.ts';

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
export function ordinal(n: number): string {
	const tens = n % 100;
	if (tens >= 11 && tens <= 13) return `${n}th`;
	return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** "42%, decoding", "3rd in the server's queue", or "Running". */
export function progressLine(t: BackgroundTask): string {
	if (t.state === 'pending') return 'Waiting to start';
	if (t.queuePosition != null) return `${ordinal(t.queuePosition)} in the server's queue`;
	const parts = [t.percent != null ? `${Math.round(t.percent)}%` : null, t.phase].filter(Boolean);
	return parts.length ? parts.join(', ') : 'Running';
}
