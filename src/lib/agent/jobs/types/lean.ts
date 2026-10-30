/**
 * Lean mode's job types (Settings → General → Lean mode): research alone.
 * Jobs of other types stay listed but are paused. They can't be made or run,
 * a scheduled run is skipped, and turning lean mode off lets them run again.
 */
import { getLiveSettings } from '#lib/stores/settings.ts';

export const LEAN_JOB_TYPES: ReadonlySet<string> = new Set(['research']);

/** Whether lean mode pauses jobs of type `id` right now. */
export function pausedByLean(id: string): boolean {
	return getLiveSettings().leanMode && !LEAN_JOB_TYPES.has(id);
}
