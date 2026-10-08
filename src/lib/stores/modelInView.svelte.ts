/**
 * The model behind whatever the user is looking at, for the header badge.
 *
 * Chat and the Shell always run on Settings → Inference. A Code session and a
 * job can each have their own remote model; when the one in view does, that
 * is the model the badge names.
 */
import type { BackendOverride } from '#lib/api.ts';
import { getActiveTab, type ActiveTab } from '#lib/stores/activeTab.svelte.ts';
import { getActiveSession } from '#lib/stores/code.svelte.ts';

export type ModelInView =
	| { kind: 'settings' }
	| { kind: 'override'; backend: BackendOverride; source: 'code' | 'job' };

/**
 * The selected job's own model, published by the Jobs tab. Null when no job
 * is selected, the job follows Settings, or the tab is gone.
 */
let jobBackend = $state<BackendOverride | null>(null);

export function setJobModelInView(backend: BackendOverride | null): void {
	jobBackend = backend;
}

/** Which model is in view, given the tab and what each tab has selected. */
export function resolveModelInView(
	tab: ActiveTab,
	codeBackend: BackendOverride | null,
	job: BackendOverride | null
): ModelInView {
	if (tab === 'code' && codeBackend) {
		return { kind: 'override', backend: codeBackend, source: 'code' };
	}
	if (tab === 'jobs' && job) {
		return { kind: 'override', backend: job, source: 'job' };
	}
	return { kind: 'settings' };
}

export function getModelInView(): ModelInView {
	const tab = getActiveTab();
	const code = tab === 'code' ? (getActiveSession()?.backend ?? null) : null;
	return resolveModelInView(tab, code, jobBackend);
}
