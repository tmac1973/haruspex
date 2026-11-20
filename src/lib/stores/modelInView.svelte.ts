/**
 * The model behind whatever the user is looking at, for the header badge.
 *
 * Chat and the Shell always run on Settings → Inference. A job can have its
 * own remote model; when the one in view does, that is the model the badge
 * names. The Code tab can show several sessions at once, each with its own
 * model and usage in its own header, so there the badge names no model and
 * only reports the Settings server.
 */
import type { BackendOverride } from '#lib/api.ts';
import { getActiveTab, type ActiveTab } from '#lib/stores/activeTab.svelte.ts';

export type ModelInView =
	{ kind: 'settings' } | { kind: 'server' } | { kind: 'override'; backend: BackendOverride };

/**
 * The selected job's own model, published by the Jobs tab. Null when no job
 * is selected, the job follows Settings, or the tab is gone.
 */
let jobBackend = $state<BackendOverride | null>(null);

export function setJobModelInView(backend: BackendOverride | null): void {
	jobBackend = backend;
}

/** Which model is in view, given the tab and what each tab has selected. */
export function resolveModelInView(tab: ActiveTab, job: BackendOverride | null): ModelInView {
	if (tab === 'code') return { kind: 'server' };
	if (tab === 'jobs' && job) return { kind: 'override', backend: job };
	return { kind: 'settings' };
}

export function getModelInView(): ModelInView {
	return resolveModelInView(getActiveTab(), jobBackend);
}
