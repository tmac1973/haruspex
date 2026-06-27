/**
 * Thin client over the Rust-side inference queue (`inference_queue.rs`).
 *
 * The admission gate used to live here as a per-webview JS semaphore, but
 * that can't coordinate once shells are detached into their own windows —
 * each webview is a separate JS context. The gate now lives in Rust, shared
 * process-wide; this module just speaks its command protocol while keeping
 * the same public API (`withInferenceSlot`, `getQueueSnapshot`,
 * `getRunningCount`) so callers (chat / shell / jobs) are unchanged.
 *
 * Protocol per turn:
 *   1. `inference_acquire(reqId, consumer, parallel, windowLabel)` — resolves
 *      when admitted, rejects if cancelled/reclaimed.
 *   2. heartbeat `inference_heartbeat(reqId)` on an interval from enqueue
 *      until release, refreshing the lease so a long turn (or a long wait
 *      behind another turn) isn't falsely reclaimed.
 *   3. `inference_cancel(reqId)` on abort, to bail a still-queued waiter.
 *   4. `inference_release(reqId)` in `finally`.
 *
 * Rust broadcasts a full `inference://queue` snapshot on every change; we
 * mirror it into `$state` so `getQueueSnapshot()`/`getRunningCount()` reflect
 * every window, not just this one.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

import { getSettings } from '$lib/stores/settings';

export type InferenceConsumer = 'chat' | 'shell' | { kind: 'job'; jobName: string };

export interface InferenceTicket {
	/** `<windowLabel>:<n>` — unique across windows. */
	id: string;
	consumer: InferenceConsumer;
	state: 'waiting' | 'running';
	enqueuedAt: number;
}

export interface WithSlotOptions {
	consumer: InferenceConsumer;
	signal?: AbortSignal;
	onTicket?: (ticket: InferenceTicket) => void;
	onAdmitted?: () => void;
}

/**
 * Refresh the lease well inside the Rust-side TTL (5 min). 60 s gives a
 * comfortable margin even if a few beats are missed while the renderer is
 * busy streaming.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;
const QUEUE_EVENT = 'inference://queue';

// --- window identity / request ids ----------------------------------------

let windowLabel: string | null = null;
function getWindowLabel(): string {
	if (windowLabel === null) {
		try {
			windowLabel = getCurrentWebviewWindow().label;
		} catch {
			// Non-Tauri context (tests) — a stable placeholder is fine.
			windowLabel = 'main';
		}
	}
	return windowLabel;
}

let reqCounter = 0;
function nextReqId(): string {
	reqCounter += 1;
	return `${getWindowLabel()}:${reqCounter}`;
}

function parallelAllowed(): boolean {
	const inf = getSettings().inferenceBackend;
	return inf.mode === 'remote' && inf.allowParallelInference;
}

// --- cross-window queue snapshot (event-mirrored) -------------------------

interface RawTicket {
	id: string;
	consumer: InferenceConsumer;
	state: 'waiting' | 'running';
	enqueuedAt: number;
}

let snapshot = $state<InferenceTicket[]>([]);
let listenerStarted = false;
let gotEvent = false;
let unlisten: UnlistenFn | null = null;

function applySnapshot(tickets: RawTicket[]): void {
	snapshot = tickets.map((t) => ({
		id: t.id,
		consumer: t.consumer,
		state: t.state,
		enqueuedAt: t.enqueuedAt
	}));
}

/**
 * Subscribe to the broadcast once, and seed from a one-shot snapshot for a
 * window that joins while turns are already in flight. Events always win
 * over the late initial fetch.
 */
function ensureSnapshotListener(): void {
	if (listenerStarted) return;
	listenerStarted = true;
	void listen<RawTicket[]>(QUEUE_EVENT, (event) => {
		gotEvent = true;
		applySnapshot(event.payload);
	}).then((un) => {
		unlisten = un;
	});
	void invoke<RawTicket[]>('inference_queue_snapshot')
		.then((tickets) => {
			if (!gotEvent) applySnapshot(tickets);
		})
		.catch(() => {});
}

/**
 * Reclaim any inference tickets the Rust queue still attributes to THIS
 * window from a previous renderer lifetime. A renderer crash or reload
 * (e.g. a webview blow-up while rendering a huge artifact) destroys the JS
 * context without firing the OS window-destroyed listener, so neither the
 * `inference_release` in withInferenceSlot's `finally` nor the primary
 * window-cleanup path runs — leaving a phantom "running" ticket that blocks
 * every new turn until the 5-min lease sweeper reclaims it. A freshly loaded
 * renderer owns no in-flight turns, so dropping all of its window's tickets
 * on startup is always safe and restores inference immediately. Call once
 * from app bootstrap.
 */
export async function reclaimOwnWindowSlots(): Promise<void> {
	try {
		await invoke('inference_release_window', { windowLabel: getWindowLabel() });
	} catch {
		// Non-Tauri context (tests / dev browser) — nothing to reclaim.
	}
}

export function getQueueSnapshot(): InferenceTicket[] {
	return snapshot;
}

export function getRunningCount(): number {
	return snapshot.filter((t) => t.state === 'running').length;
}

// --- the gate -------------------------------------------------------------

/**
 * Run `fn` while holding a process-wide inference slot. Resolves once `fn`
 * resolves; releases the slot on success, error, or abort. `onTicket` fires
 * with the waiting ticket so the UI can render "waiting behind …";
 * `onAdmitted` fires when the slot is granted.
 *
 * Honors `signal`: aborting before admission cancels the queued waiter and
 * throws `AbortError` without ever calling `fn`. Aborting while `fn` runs is
 * `fn`'s responsibility to propagate; the slot is released regardless.
 */
export async function withInferenceSlot<T>(
	options: WithSlotOptions,
	fn: () => Promise<T>
): Promise<T> {
	const { consumer, signal, onTicket, onAdmitted } = options;
	if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

	ensureSnapshotListener();

	const reqId = nextReqId();
	onTicket?.({ id: reqId, consumer, state: 'waiting', enqueuedAt: Date.now() });

	// Heartbeat from enqueue (covers the waiting period too).
	const heartbeat = setInterval(() => {
		void invoke('inference_heartbeat', { reqId }).catch(() => {});
	}, HEARTBEAT_INTERVAL_MS);

	let abortInitiated = false;
	let abortListener: (() => void) | null = null;
	if (signal) {
		abortListener = () => {
			abortInitiated = true;
			void invoke('inference_cancel', { reqId }).catch(() => {});
		};
		signal.addEventListener('abort', abortListener);
	}

	try {
		await invoke('inference_acquire', {
			reqId,
			consumer,
			parallel: parallelAllowed(),
			windowLabel: getWindowLabel()
		});
		// Abort could have raced in between the grant and here.
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		onAdmitted?.();
		return await fn();
	} catch (e) {
		// A cancelled/reclaimed acquire rejects; surface it as AbortError when
		// we (or the caller's signal) initiated the abort, so callers see a
		// consistent "Aborted" rather than the raw Rust string.
		if (abortInitiated || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		throw e;
	} finally {
		clearInterval(heartbeat);
		if (abortListener && signal) signal.removeEventListener('abort', abortListener);
		// Harmless no-op server-side if the ticket was never admitted.
		void invoke('inference_release', { reqId }).catch(() => {});
	}
}

/** Test-only hook to reset module state between cases. */
export function _resetForTests(): void {
	snapshot = [];
	reqCounter = 0;
	windowLabel = null;
	listenerStarted = false;
	gotEvent = false;
	if (unlisten) {
		unlisten();
		unlisten = null;
	}
}
