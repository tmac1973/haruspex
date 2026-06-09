// Pure routing for the Python worker's inbound messages, split out of
// python.worker.ts so it's unit-testable without booting Pyodide (that
// module loads the runtime and calls init() at import time). The worker
// supplies a WorkerMessageHandlers implementation that closes over its
// module state; here we only route and settle pending requests.

import type { MainToWorker } from './protocol';

type SyncWorkdirMsg = Extract<MainToWorker, { kind: 'sync_workdir_files' }>;
type SaveResponseMsg = Extract<MainToWorker, { kind: 'save_response' }>;
type DeleteResponseMsg = Extract<MainToWorker, { kind: 'delete_response' }>;
type FetchResponseMsg = Extract<MainToWorker, { kind: 'fetch_response' }>;

/** The side effects the worker performs for each inbound message kind. */
export interface WorkerMessageHandlers {
	setInterruptBuffer(buffer: SharedArrayBuffer): void;
	resolveProxyMode(mode: string, workingDirSet: boolean): void;
	syncWorkdir(msg: SyncWorkdirMsg): void;
	run(id: string, code: string): void;
	install(id: string, packageName: string): void;
	acknowledgeReset(id: string): void;
	interrupt(): void;
	listGlobals(id: string): void;
	settleSave(msg: SaveResponseMsg): void;
	settleDelete(msg: DeleteResponseMsg): void;
	settleFetch(msg: FetchResponseMsg): void;
}

/** Route one main→worker message to the matching handler. */
export function dispatchWorkerMessage(msg: MainToWorker, h: WorkerMessageHandlers): void {
	switch (msg.kind) {
		case 'set_interrupt_buffer':
			return h.setInterruptBuffer(msg.buffer);
		case 'proxy_mode':
			return h.resolveProxyMode(msg.mode, msg.workingDirSet);
		case 'sync_workdir_files':
			return h.syncWorkdir(msg);
		case 'run':
			return h.run(msg.id, msg.code);
		case 'install':
			return h.install(msg.id, msg.package);
		case 'reset':
			return h.acknowledgeReset(msg.id);
		case 'interrupt':
			return h.interrupt();
		case 'list_globals':
			return h.listGlobals(msg.id);
		case 'save_response':
			return h.settleSave(msg);
		case 'delete_response':
			return h.settleDelete(msg);
		case 'fetch_response':
			return h.settleFetch(msg);
	}
}

export interface PendingSettler<T> {
	resolve: (value: T) => void;
	reject: (err: Error) => void;
}

/**
 * Resolve or reject the pending request `requestId` in `map`, removing its
 * entry. A no-op when the id isn't present (a response for an already-settled
 * or unknown request — e.g. after a reset).
 */
export function settlePending<T>(
	map: Map<string, PendingSettler<T>>,
	requestId: string,
	outcome: { ok: true; value: T } | { ok: false; error: string }
): void {
	const pending = map.get(requestId);
	if (!pending) return;
	map.delete(requestId);
	if (outcome.ok) pending.resolve(outcome.value);
	else pending.reject(new Error(outcome.error));
}
