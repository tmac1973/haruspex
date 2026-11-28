/**
 * What pictures and clips made on a paid service (OpenRouter) have cost,
 * summed since the user last reset the count in Settings → Image generation
 * or Settings → Video generation. Local and self-hosted backends cost
 * nothing and never land here.
 *
 * Each sum is the price the service reported with the result (`usage.cost`).
 * A result it reported no price for is counted in `unpriced`, so the total
 * says when it is short. Kept in localStorage: a count for the user to
 * watch, not a bill.
 */

import { persistItem } from '#lib/persist.ts';

const KEY = 'haruspex.generation.spend';

export interface GenerationSpend {
	/** US dollars. */
	usd: number;
	pictures: number;
	clips: number;
	/** Pictures and clips made with no price reported. */
	unpriced: number;
	/** When the count began (ISO 8601). */
	since: string;
}

function fresh(): GenerationSpend {
	return { usd: 0, pictures: 0, clips: 0, unpriced: 0, since: new Date().toISOString() };
}

const count = (v: unknown): number =>
	typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

function load(): GenerationSpend {
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
		if (!raw || typeof raw !== 'object') return fresh();
		const r = raw as Record<string, unknown>;
		return {
			usd: count(r.usd),
			pictures: count(r.pictures),
			clips: count(r.clips),
			unpriced: count(r.unpriced),
			since: typeof r.since === 'string' ? r.since : new Date().toISOString()
		};
	} catch {
		return fresh();
	}
}

// Read once at start: a lazy read would write state inside the `$derived` that asked first.
let spend = $state<GenerationSpend>(load());

const current = (): GenerationSpend => spend;

function save(next: GenerationSpend): void {
	spend = next;
	try {
		persistItem(KEY, JSON.stringify(next));
	} catch {
		// Storage full or refused: the count still lasts until the app closes.
	}
}

export function generationSpend(): GenerationSpend {
	return current();
}

/**
 * `made` pictures or clips that cost `usd` together, or that came with no
 * price (`null`).
 */
export function recordSpend(what: 'picture' | 'clip', made: number, usd: number | null): void {
	if (made <= 0) return;
	const now = current();
	const priced = usd !== null && Number.isFinite(usd) && usd >= 0;
	save({
		...now,
		usd: now.usd + (priced ? usd : 0),
		pictures: now.pictures + (what === 'picture' ? made : 0),
		clips: now.clips + (what === 'clip' ? made : 0),
		unpriced: now.unpriced + (priced ? 0 : made)
	});
}

export function resetGenerationSpend(): void {
	save(fresh());
}

/** Read the count from localStorage again, as a restart would. */
export function _resetForTests(): void {
	spend = load();
}
