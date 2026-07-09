/**
 * Cached job-type availability for synchronous UI reads (picker filtering,
 * JobList run-button state). `available()` gates are async (platform probes
 * over IPC), so the Jobs tab kicks off one load and the UI reads the cached
 * answer reactively. The runner's enqueue() still awaits the definition's
 * `available()` directly — that check is authoritative; this cache is
 * display-only.
 */

import { listJobTypes } from './registry';

let availability = $state<Record<string, boolean>>({});
let loadStarted = false;

/** Probe every gated type once (idempotent; call from the Jobs tab). */
export async function ensureTypeAvailabilityLoaded(): Promise<void> {
	if (loadStarted) return;
	loadStarted = true;
	for (const def of listJobTypes()) {
		if (!def.available) continue;
		let ok = false;
		try {
			ok = await def.available();
		} catch {
			ok = false;
		}
		availability = { ...availability, [def.id]: ok };
	}
}

/**
 * Whether a type is available on this platform. Ungated types are always
 * available; gated types report unavailable until their probe completes
 * (no flash of an option that then disappears).
 */
export function isJobTypeAvailable(id: string): boolean {
	const cached = availability[id];
	if (cached !== undefined) return cached;
	const def = listJobTypes().find((d) => d.id === id);
	return !def?.available;
}
