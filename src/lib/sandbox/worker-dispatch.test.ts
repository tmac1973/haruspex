import { describe, it, expect, vi } from 'vitest';
import {
	dispatchWorkerMessage,
	settlePending,
	type WorkerMessageHandlers,
	type PendingSettler
} from './worker-dispatch';
import type { MainToWorker } from './protocol';

function mockHandlers(): WorkerMessageHandlers {
	return {
		setInterruptBuffer: vi.fn(),
		resolveProxyMode: vi.fn(),
		syncWorkdir: vi.fn(),
		run: vi.fn(),
		install: vi.fn(),
		acknowledgeReset: vi.fn(),
		interrupt: vi.fn(),
		listGlobals: vi.fn(),
		settleSave: vi.fn(),
		settleDelete: vi.fn(),
		settleFetch: vi.fn()
	};
}

describe('dispatchWorkerMessage', () => {
	it('routes the id-carrying control messages', () => {
		const h = mockHandlers();
		dispatchWorkerMessage({ kind: 'run', id: 'a', code: 'print(1)' }, h);
		expect(h.run).toHaveBeenCalledWith('a', 'print(1)');
		dispatchWorkerMessage({ kind: 'install', id: 'b', package: 'numpy' }, h);
		expect(h.install).toHaveBeenCalledWith('b', 'numpy');
		dispatchWorkerMessage({ kind: 'list_globals', id: 'c' }, h);
		expect(h.listGlobals).toHaveBeenCalledWith('c');
		dispatchWorkerMessage({ kind: 'reset', id: 'd' }, h);
		expect(h.acknowledgeReset).toHaveBeenCalledWith('d');
		dispatchWorkerMessage({ kind: 'interrupt', id: 'e' }, h);
		expect(h.interrupt).toHaveBeenCalledOnce();
	});

	it('unpacks proxy_mode and set_interrupt_buffer args', () => {
		const h = mockHandlers();
		dispatchWorkerMessage({ kind: 'proxy_mode', mode: 'manual', workingDirSet: true }, h);
		expect(h.resolveProxyMode).toHaveBeenCalledWith('manual', true);
		const buffer = new SharedArrayBuffer(4);
		dispatchWorkerMessage({ kind: 'set_interrupt_buffer', buffer }, h);
		expect(h.setInterruptBuffer).toHaveBeenCalledWith(buffer);
	});

	it('forwards sync + the three *_response messages to their settlers', () => {
		const h = mockHandlers();
		const sync: MainToWorker = {
			kind: 'sync_workdir_files',
			sync_id: 's',
			workdir_abs: '/w',
			to_sync: [],
			deleted: [],
			skipped: []
		};
		dispatchWorkerMessage(sync, h);
		expect(h.syncWorkdir).toHaveBeenCalledWith(sync);

		const save: MainToWorker = {
			kind: 'save_response',
			id: 'x',
			request_id: 'r1',
			ok: true,
			path: '/x',
			bytes: 2
		};
		dispatchWorkerMessage(save, h);
		expect(h.settleSave).toHaveBeenCalledWith(save);

		const del: MainToWorker = {
			kind: 'delete_response',
			id: 'x',
			request_id: 'r2',
			ok: true,
			path: '/y'
		};
		dispatchWorkerMessage(del, h);
		expect(h.settleDelete).toHaveBeenCalledWith(del);

		const fetch: MainToWorker = {
			kind: 'fetch_response',
			id: 'x',
			request_id: 'r3',
			ok: true,
			status: 200,
			headers: {},
			body: new Uint8Array(),
			url: 'https://x'
		};
		dispatchWorkerMessage(fetch, h);
		expect(h.settleFetch).toHaveBeenCalledWith(fetch);
	});
});

describe('settlePending', () => {
	it('resolves with the value and removes the entry', async () => {
		const map = new Map<string, PendingSettler<number>>();
		const p = new Promise<number>((resolve, reject) => map.set('r', { resolve, reject }));
		settlePending(map, 'r', { ok: true, value: 42 });
		await expect(p).resolves.toBe(42);
		expect(map.has('r')).toBe(false);
	});

	it('rejects with an Error and removes the entry', async () => {
		const map = new Map<string, PendingSettler<number>>();
		const p = new Promise<number>((resolve, reject) => map.set('r', { resolve, reject }));
		settlePending(map, 'r', { ok: false, error: 'boom' });
		await expect(p).rejects.toThrow('boom');
		expect(map.has('r')).toBe(false);
	});

	it('is a no-op for an unknown request id', () => {
		const map = new Map<string, PendingSettler<number>>();
		expect(() => settlePending(map, 'ghost', { ok: true, value: 1 })).not.toThrow();
	});
});
