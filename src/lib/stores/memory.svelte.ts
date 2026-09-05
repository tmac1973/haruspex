/**
 * Cross-chat memory: the global switch and the embedding model behind it.
 *
 * Two things have to be true before memory does anything — the user turned it
 * on, and the ~65 MB embedding model is on disk — and they can disagree.
 * Settings sync onto a fresh machine carries the flag but not the weights, so
 * `memoryActive()` is what every caller should ask; the raw setting is not a
 * capability.
 *
 * The download is only ever started by a person pressing a button. A
 * privacy-focused app does not fetch from Hugging Face on the user's behalf
 * because a restored config file said it could.
 *
 * See `plan/archive/agentic-memory/phase-02-settings-and-model-consent.md`.
 */

import { invoke } from '@tauri-apps/api/core';
import { getSettings, updateSettings } from '$lib/stores/settings';
import { logDebug } from '$lib/debug-log';

/**
 * - `unknown`     — not checked yet this session (the initial render)
 * - `absent`      — checked, not on disk; the consent prompt is what shows
 * - `downloading` — a download this session is in flight
 * - `ready`       — on disk and usable
 * - `error`       — a download was attempted and failed; `error` says why
 */
export type ModelStatus = 'unknown' | 'absent' | 'downloading' | 'ready' | 'error';

interface MemoryState {
	status: ModelStatus;
	error: string | null;
	count: number;
}

const state = $state<MemoryState>({ status: 'unknown', error: null, count: 0 });

export function getModelStatus(): ModelStatus {
	return state.status;
}

export function getModelError(): string | null {
	return state.error;
}

export function getMemoryCount(): number {
	return state.count;
}

/**
 * Whether memory should actually do anything right now.
 *
 * The single question extraction and recall ask. Deliberately synchronous and
 * cheap: it is checked on every send, and it must never be the reason a chat
 * turn waits on IPC.
 */
export function memoryActive(): boolean {
	return getSettings().memoryEnabled && state.status === 'ready';
}

/** Re-check the model on disk. Cheap (a file check) — safe to call on render. */
export async function refreshModelStatus(): Promise<void> {
	// A download in flight owns the status; a stale file check landing
	// mid-download would flip the UI back to "absent" under the progress bar.
	if (state.status === 'downloading') return;
	try {
		const present = await invoke<boolean>('memory_model_present');
		state.status = present ? 'ready' : 'absent';
		if (present) state.error = null;
	} catch (e) {
		logDebug('memory', 'model status check failed', { error: String(e) });
		state.status = 'absent';
	}
}

export async function refreshMemoryCount(): Promise<void> {
	try {
		state.count = await invoke<number>('memory_count');
	} catch (e) {
		logDebug('memory', 'memory count failed', { error: String(e) });
	}
}

/**
 * Download the embedding model. Resolves true when it is ready to use.
 *
 * Does NOT flip the setting — enabling memory is a separate, explicit act.
 * Someone may reasonably want the model on disk before deciding.
 */
export async function downloadModel(): Promise<boolean> {
	if (state.status === 'downloading') return false;
	state.status = 'downloading';
	state.error = null;
	try {
		await invoke('memory_download_model');
		state.status = 'ready';
		return true;
	} catch (e) {
		// Surfaced in the card rather than swallowed: the most likely cause is
		// no network, and a toggle that silently refuses to move is worse than
		// one that says why.
		state.error = e instanceof Error ? e.message : String(e);
		state.status = 'error';
		logDebug('memory', 'model download failed', { error: state.error });
		return false;
	}
}

/**
 * Turn memory on, downloading the model first if it is missing.
 *
 * Returns false when the model could not be obtained — the caller leaves the
 * toggle off, because a "memory on" state with no way to embed would silently
 * do nothing.
 */
export async function enableMemory(): Promise<boolean> {
	if (state.status !== 'ready') {
		const ok = await downloadModel();
		if (!ok) return false;
	}
	updateSettings({ memoryEnabled: true });
	await refreshMemoryCount();
	return true;
}

/**
 * Turn memory off and release the ONNX session.
 *
 * The weights stay cached: switching off is not "forget everything", and
 * re-downloading 65 MB to change one's mind back would be a poor trade. The
 * loaded session is dropped though — tens of MB resident for a feature that
 * is now off.
 */
export async function disableMemory(): Promise<void> {
	updateSettings({ memoryEnabled: false });
	try {
		await invoke('memory_unload_model');
	} catch (e) {
		// Not worth surfacing: the setting is already off, so nothing will
		// embed regardless of whether the session was actually released.
		logDebug('memory', 'model unload failed', { error: String(e) });
	}
}

/** Test seam — resets module state between cases. */
export function __resetMemoryStateForTests(): void {
	state.status = 'unknown';
	state.error = null;
	state.count = 0;
}
