/**
 * Frontend half of the job-run sleep inhibitor (Rust side: src-tauri/src/power.rs).
 *
 * The runner declares intent — "a run is in flight" / "nothing is running" —
 * and this module reconciles that against the OS, serialising the invokes so
 * a fast finish-then-start queue drain can't land a release after the next
 * run's acquire.
 */
import { invoke } from '@tauri-apps/api/core';
import { IPC } from '$lib/ipc/commands';
import { logDebug } from '$lib/debug-log';

let desired = false;
let applied = false;
// Set synchronously at the top of reconcile() rather than by assigning its
// promise at the call site: a pass that needs no invoke never awaits, so its
// `finally` would run *before* the caller's assignment and the flag would
// latch on forever, wedging every later transition.
let running = false;
// One warning per session: a machine without logind / a session bus fails
// every time, and a log full of it helps nobody.
let warned = false;

async function reconcile(): Promise<void> {
	running = true;
	try {
		// Re-read `desired` each pass: it can change while an invoke is
		// awaited, and the last value written is the one that must win.
		while (desired !== applied) {
			const target = desired;
			try {
				await invoke(target ? IPC.power_inhibit_acquire : IPC.power_inhibit_release);
			} catch (e) {
				// Never a reason to fail a run — the job just runs on a machine
				// that may sleep under it. `applied` is left alone, so the next
				// transition retries rather than assuming the worst forever.
				if (!warned) {
					warned = true;
					console.warn('keeping the machine awake for job runs is unavailable', e);
				}
				return;
			}
			applied = target;
			logDebug('jobs', target ? 'sleep inhibited' : 'sleep inhibit released');
		}
	} finally {
		running = false;
	}
}

/**
 * Declare whether the machine should be held awake. Idempotent and cheap to
 * call on every runner state change — only an actual change reaches the OS.
 */
export function setKeepAwake(next: boolean): void {
	if (desired === next) return;
	desired = next;
	if (!running) void reconcile();
}

/**
 * Clear an inhibit stranded by a previous renderer lifetime. The Rust process
 * outlives a webview reload or crash, so an inhibit taken by the last page
 * load would otherwise hold the machine awake until the app exits. Same
 * reasoning as reclaimOwnWindowSlots() for the inference queue.
 */
export async function releaseStaleInhibit(): Promise<void> {
	try {
		await invoke(IPC.power_inhibit_release);
		applied = false;
	} catch {
		// Browser dev mode, or the command is simply unavailable — nothing
		// was inhibited in that case either.
	}
}
