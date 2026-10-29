import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MainToWorker, ToolResult, WorkerToMain } from './protocol';

// Worker-manager pulls in a few app singletons; stub them so the manager is
// exercised in isolation. getWorkingDir → null (unless a test sets one) keeps
// the pre-run workdir sync a no-op (so runPython drives straight through to `send`).
const invokeMock = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({
	workingDir: null as string | null,
	folders: {} as Record<string, string | null>
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('#lib/stores/session.svelte.ts', () => ({
	getWorkingDir: () => session.workingDir,
	getWorkingDirFor: (id: string) => session.folders[id] ?? null
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: { proxy: { mode: 'none' }, sandboxNetAccess: 'internet' }
	})
);
vi.mock('#lib/debugLog.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debugLog.ts')>()),
	logDebug: () => {}
}));

import { WorkerManager } from './workerManager';
import { PYTHON_UNAVAILABLE, pythonRuntimeMissing } from './availability';

/** Minimal Worker stand-in: captures postMessage and replays messages. */
class FakeWorker {
	posted: MainToWorker[] = [];
	transfers: Transferable[][] = [];
	private onMessage?: (e: MessageEvent<WorkerToMain>) => void;
	addEventListener(type: string, cb: EventListenerOrEventListenerObject): void {
		if (type === 'message') this.onMessage = cb as (e: MessageEvent<WorkerToMain>) => void;
	}
	postMessage(msg: MainToWorker, transfer: Transferable[] = []): void {
		this.posted.push(msg);
		this.transfers.push(transfer);
	}
	terminate(): void {}
	/** Deliver a worker→main message to the manager. */
	emit(msg: WorkerToMain): void {
		this.onMessage?.({ data: msg } as MessageEvent<WorkerToMain>);
	}
	postedKinds(): string[] {
		return this.posted.map((m) => m.kind);
	}
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function doneResult(over: Partial<ToolResult> = {}): ToolResult {
	return {
		stdout: '',
		stderr: '',
		result: '',
		error: null,
		artifacts: 0,
		artifactsList: [],
		notes: [],
		duration_ms: 1,
		...over
	};
}

/** Find the `run` message the manager posted and return its generated id. */
function runId(fake: FakeWorker): string {
	const m = fake.posted.find((x) => x.kind === 'run');
	if (!m || m.kind !== 'run') throw new Error('no run message posted');
	return m.id;
}

describe('WorkerManager message dispatch', () => {
	let fake: FakeWorker;
	function makeManager(isolated = false, chatId?: string) {
		fake = new FakeWorker();
		return new WorkerManager(() => fake as unknown as Worker, {
			isIsolated: () => isolated,
			chatId
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		session.workingDir = null;
		session.folders = {};
	});

	it('tells the model Python is unavailable when its runtime is missing, and remembers', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const wm = makeManager();
		const p = wm.runPython('print(1)');
		fake.emit({
			kind: 'load_error',
			error:
				'The Python runtime is missing from /pyodide/. In a dev checkout, run ./scripts/fetch-pyodide.sh.',
			runtimeMissing: true
		});
		await expect(p).rejects.toThrow(PYTHON_UNAVAILABLE);
		expect(pythonRuntimeMissing()).toBe(true);
		// The setup hint goes to the log, for whoever runs this checkout.
		expect(warn).toHaveBeenCalledWith(
			'python sandbox:',
			expect.stringContaining('fetch-pyodide.sh')
		);
		warn.mockRestore();
	});

	it('runs to completion, forwarding stdout and the final result', async () => {
		const wm = makeManager();
		const stdout: string[] = [];
		const p = wm.runPython('print(1)', { onStdout: (c) => stdout.push(c) });

		fake.emit({ kind: 'ready' });
		await tick(); // waitForReady → send posts the `run` message
		const id = runId(fake);

		fake.emit({ kind: 'exec_start', id });
		fake.emit({ kind: 'stdout', id, data: 'hi\n' });
		fake.emit({ kind: 'done', id, result: doneResult({ result: '42', stdout: 'hi\n' }) });

		const result = await p;
		expect(result.result).toBe('42');
		expect(stdout).toEqual(['hi\n']);
	});

	it('hands Rust the network policy before the code runs', async () => {
		// The haruspexfetch: scheme behind sync requests/urllib reads it from
		// there, so it has to be in place before any Python executes.
		const wm = makeManager();
		void wm.runPython('print(1)', {});
		fake.emit({ kind: 'ready' });
		await tick();
		expect(invokeMock).toHaveBeenCalledWith('sandbox_set_network', {
			proxy: { mode: 'none' },
			access: 'internet'
		});
		expect(fake.postedKinds()).toContain('run');
	});

	it('accumulates artifacts into the resolved result', async () => {
		const wm = makeManager();
		const p = wm.runPython('plot()');
		fake.emit({ kind: 'ready' });
		await tick();
		const id = runId(fake);

		fake.emit({ kind: 'exec_start', id });
		fake.emit({
			kind: 'artifact',
			id,
			mime: 'text/html',
			payload: { kind: 'text', text: '<b>table</b>' }
		});
		fake.emit({ kind: 'done', id, result: doneResult() });

		const result = await p;
		expect(result.artifacts).toBe(1);
		expect(result.artifactsList).toHaveLength(1);
		expect(result.artifactsList[0]).toMatchObject({ kind: 'html', html: '<b>table</b>' });
	});

	it('replies to a get_runtime_config request with the current settings', async () => {
		const wm = makeManager();
		wm.runPython('x').catch(() => {}); // spawns the worker + registers the listener
		fake.emit({ kind: 'ready' });
		fake.emit({ kind: 'get_runtime_config' });
		const reply = fake.posted.find((m) => m.kind === 'runtime_config');
		expect(reply).toMatchObject({ kind: 'runtime_config', workingDirSet: false });
	});

	it('does not arm the interrupt buffer when not cross-origin-isolated', async () => {
		const wm = makeManager(false);
		wm.runPython('x').catch(() => {});
		fake.emit({ kind: 'ready' });
		expect(fake.postedKinds()).not.toContain('set_interrupt_buffer');
	});

	it('arms the interrupt buffer on ready when isolated', async () => {
		const wm = makeManager(true);
		wm.runPython('x').catch(() => {});
		fake.emit({ kind: 'ready' });
		expect(fake.postedKinds()).toContain('set_interrupt_buffer');
	});

	it('ignores messages for unknown run ids', async () => {
		const wm = makeManager();
		wm.runPython('x').catch(() => {});
		fake.emit({ kind: 'ready' });
		// stdout/done for a run that was never dispatched must not throw.
		expect(() => {
			fake.emit({ kind: 'stdout', id: 'ghost', data: 'x' });
			fake.emit({ kind: 'done', id: 'ghost', result: doneResult() });
		}).not.toThrow();
	});

	it('hands the worker the working folder by transfer, not by copy', async () => {
		// A first sync can carry thousands of files: parsing them on the main
		// thread froze the window. The body arrives binary and goes on whole.
		session.workingDir = '/w';
		const json = new TextEncoder().encode(
			JSON.stringify({
				to_sync: [{ path: 'a.txt', abs_path: '/w/a.txt', mtime: 1, len: 2 }],
				deleted: [],
				skipped: [],
				workdir_abs: '/w'
			})
		);
		const body = new Uint8Array(4 + json.length + 2);
		new DataView(body.buffer).setUint32(0, json.length, true);
		body.set(json, 4);
		body.set([7, 8], 4 + json.length);
		invokeMock.mockImplementation(async (cmd: string) =>
			cmd === 'sandbox_sync_workdir' ? body.buffer : undefined
		);
		const wm = makeManager();
		void wm.runPython('print(1)');
		fake.emit({ kind: 'ready' });
		await tick();
		const at = fake.posted.findIndex((m) => m.kind === 'sync_workdir_files');
		const sync = fake.posted[at];
		if (sync?.kind !== 'sync_workdir_files') throw new Error('no sync posted');
		expect(Array.from(sync.to_sync[0].bytes)).toEqual([7, 8]);
		expect(fake.transfers[at]).toEqual([body.buffer]);
		fake.emit({ kind: 'sync_workdir_ack', sync_id: sync.sync_id });
		await tick();
		expect(fake.postedKinds()).toContain('run');
	});

	it("syncs its own chat's folder, not the open chat's", async () => {
		// A turn in a chat that isn't open runs Python against that chat's folder.
		session.workingDir = '/open';
		session.folders = { b: '/b' };
		invokeMock.mockImplementation(async () => {
			throw new Error('stop after the sync request');
		});
		const wm = makeManager(false, 'b');
		void wm.runPython('print(1)').catch(() => {});
		fake.emit({ kind: 'ready' });
		await tick();
		expect(invokeMock).toHaveBeenCalledWith(
			'sandbox_sync_workdir',
			expect.objectContaining({ workdir: '/b' })
		);
	});
});
