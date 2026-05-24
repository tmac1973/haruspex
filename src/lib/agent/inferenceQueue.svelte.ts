/**
 * App-wide queue for in-flight agent turns.
 *
 * The chat tab and the jobs runner both call `runAgentLoop`, which POSTs
 * to the configured inference backend. We funnel every such call through
 * this module so:
 *
 *  - The local llama-server (one slot by default) doesn't get a second
 *    request stuck waiting in its HTTP queue with no UI feedback.
 *  - Remote backends that DO support concurrency (vLLM, llama-server
 *    with `-np N`, hosted APIs) can be opted into true parallel mode
 *    via the inferenceBackend.allowParallelInference setting — the
 *    queue then short-circuits to no-op acquire/release.
 *
 * Capacity is fixed at 1 for local mode and 1-or-unbounded for remote
 * mode depending on the setting. We re-read the setting at every acquire
 * so the change takes effect without a restart.
 *
 * Each waiter is given a stable ticket id so the UI can render WHO is
 * waiting and WHO is running ("Chat is queued behind Morning headlines").
 */

import { getSettings } from '$lib/stores/settings';

export type InferenceConsumer = 'chat' | { kind: 'job'; jobName: string };

export interface InferenceTicket {
	id: number;
	consumer: InferenceConsumer;
	state: 'waiting' | 'running';
	enqueuedAt: number;
}

interface Waiter {
	id: number;
	resolve: () => void;
}

let nextTicketId = 1;
const queue = $state<InferenceTicket[]>([]);
let pendingWaiters: Waiter[] = [];
let runningCount = 0;

export function getQueueSnapshot(): InferenceTicket[] {
	return queue;
}

export function getRunningCount(): number {
	return runningCount;
}

function currentCapacity(): number {
	const inf = getSettings().inferenceBackend;
	if (inf.mode === 'remote' && inf.allowParallelInference) {
		// Effectively unbounded — the remote server decides what to batch.
		return Number.POSITIVE_INFINITY;
	}
	return 1;
}

function pump(): void {
	while (pendingWaiters.length > 0 && runningCount < currentCapacity()) {
		const next = pendingWaiters.shift();
		if (!next) break;
		const idx = queue.findIndex((t) => t.id === next.id);
		if (idx >= 0) {
			// Direct mutation: queue is $state so the slot's `state` field
			// updates reactively for any subscriber rendering the queue.
			queue[idx].state = 'running';
		}
		runningCount++;
		next.resolve();
	}
}

export interface WithSlotOptions {
	consumer: InferenceConsumer;
	signal?: AbortSignal;
	onTicket?: (ticket: InferenceTicket) => void;
	onAdmitted?: () => void;
}

/**
 * Run `fn` with a queue slot held for its duration. The promise resolves
 * once `fn` resolves; any thrown error propagates after the slot is
 * released. The ticket is exposed via `onTicket` so UI can render the
 * waiting/running indicator for this specific caller. `onAdmitted` fires
 * when the slot is granted — the caller uses it to flip a "waiting"
 * indicator to "running" without having to subscribe to the queue.
 *
 * Honors `signal`: aborting before the slot is granted bails out without
 * ever calling `fn`. Aborting while `fn` is running is `fn`'s problem
 * (it should propagate the AbortError through this call).
 */
export async function withInferenceSlot<T>(
	options: WithSlotOptions,
	fn: () => Promise<T>
): Promise<T> {
	const { consumer, signal, onTicket, onAdmitted } = options;
	if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

	const id = nextTicketId++;
	const ticket: InferenceTicket = {
		id,
		consumer,
		state: 'waiting',
		enqueuedAt: Date.now()
	};
	queue.push(ticket);
	onTicket?.(ticket);

	let abortListener: (() => void) | null = null;
	const ready = new Promise<void>((resolve, reject) => {
		pendingWaiters.push({ id, resolve });
		if (signal) {
			abortListener = () => reject(new DOMException('Aborted', 'AbortError'));
			signal.addEventListener('abort', abortListener);
		}
	});
	pump();

	let admitted = false;
	try {
		await ready;
		admitted = true;
		onAdmitted?.();
		return await fn();
	} finally {
		if (abortListener && signal) signal.removeEventListener('abort', abortListener);
		const idx = queue.findIndex((t) => t.id === id);
		if (idx >= 0) queue.splice(idx, 1);
		pendingWaiters = pendingWaiters.filter((w) => w.id !== id);
		if (admitted && runningCount > 0) runningCount--;
		pump();
	}
}

/** Test-only hook to reset module state between cases. */
export function _resetForTests(): void {
	queue.splice(0, queue.length);
	pendingWaiters = [];
	runningCount = 0;
	nextTicketId = 1;
}
