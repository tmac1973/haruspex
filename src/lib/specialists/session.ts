/** Which specialists a Code session offers. */
import { specialistEntries } from '#lib/specialists/entries.ts';
import type { SpecialistEntry } from '#lib/specialists/types.ts';

/**
 * The session's stored ids, in Settings order. Null means the entries marked
 * on by default; an id whose entry was deleted is ignored.
 */
export function sessionSpecialists(stored: string[] | null): SpecialistEntry[] {
	const entries = specialistEntries();
	if (stored === null) return entries.filter((e) => e.onByDefault);
	const on = new Set(stored);
	return entries.filter((e) => on.has(e.id));
}
