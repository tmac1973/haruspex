/**
 * Opening a new job's draft in the Jobs tab from any window. The Jobs tab is
 * the main window's, and every window has its own stores, so a detached Code
 * window hands its draft to the main window instead of setting its own.
 */
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { setActiveTab } from '#lib/stores/activeTab.svelte.ts';
import { newJobDraft, type JobDraft } from '#lib/stores/jobsTabSelection.svelte.ts';

/** Another window → main: open this draft in the Jobs tab. */
export const JOB_DRAFT_EVENT = 'jobs://draft';

function inMainWindow(): boolean {
	try {
		return getCurrentWebviewWindow().label === 'main';
	} catch {
		// Not in Tauri (tests): there is one window.
		return true;
	}
}

function showHere(draft: JobDraft): void {
	newJobDraft(draft);
	setActiveTab('jobs');
}

/** Show `draft` in the Jobs tab, unsaved, in the main window. */
export async function openJobDraft(draft: JobDraft): Promise<void> {
	if (inMainWindow()) {
		showHere(draft);
		return;
	}
	await emitTo('main', JOB_DRAFT_EVENT, draft);
}

/** Main window only: drafts other windows hand over. Resolves to the function that stops it. */
export async function listenForJobDrafts(): Promise<() => void> {
	return listen<JobDraft>(JOB_DRAFT_EVENT, (e) => {
		showHere(e.payload);
		const w = getCurrentWindow();
		void w
			.unminimize()
			.then(() => w.setFocus())
			.catch(() => {});
	});
}
