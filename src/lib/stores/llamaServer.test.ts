import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeCalls, invokeRouter } from '#lib/testing/invoke.ts';
import type { SidecarStatus } from '#lib/ipc/gen/SidecarStatus.ts';

const tauri = vi.hoisted(() => ({
	invoke: vi.fn(),
	listeners: new Map<string, (event: { payload: unknown }) => void>()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
		tauri.listeners.set(name, handler);
		return () => tauri.listeners.delete(name);
	})
}));

// How many inference turns are running anywhere — what decides whether a
// restart has to wait.
const queue = vi.hoisted(() => ({ running: 0 }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	getRunningCount: () => queue.running
}));

// The store is module-level $state — re-import fresh per test so a pending
// restart or a remote label can't leak between tests.
async function freshStore() {
	return import('#lib/stores/llamaServer.svelte.ts');
}

function emitStatus(payload: SidecarStatus): void {
	const handler = tauri.listeners.get('server-status-changed');
	if (!handler) throw new Error('status listener not attached');
	handler({ payload });
}

/** The (model, context) pairs the sidecar was started with, in order. */
function starts(): [unknown, unknown][] {
	return invokeCalls(tauri.invoke, 'start_server').map((a) => [a?.modelPath, a?.ctxSize]);
}

beforeEach(() => {
	vi.resetModules();
	tauri.invoke.mockReset();
	tauri.invoke.mockImplementation(invokeRouter({}));
	tauri.listeners.clear();
	queue.running = 0;
});

describe('starting and stopping', () => {
	it('startServer shows "starting" and launches the given model', async () => {
		const { startServer, getServerState } = await freshStore();
		await startServer('/models/a.gguf', 8192);
		expect(getServerState().status).toBe('starting');
		expect(starts()).toEqual([['/models/a.gguf', 8192]]);
	});

	it('startServer shows the error when the launch fails', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				start_server: () => {
					throw 'model file not found';
				}
			})
		);
		const { startServer, getServerState } = await freshStore();
		await startServer('/models/missing.gguf');
		expect(getServerState().status).toBe('error');
		expect(getServerState().errorMessage).toBe('model file not found');
	});

	it('startServer clears the CPU-fallback banner straight away', async () => {
		const { initServerStore, startServer, getServerState } = await freshStore();
		await initServerStore();
		tauri.listeners.get('gpu-fallback-active')!({ payload: { reason: 'out of VRAM' } });
		expect(getServerState().cpuFallback).toEqual({ reason: 'out of VRAM' });

		await startServer('/models/a.gguf');
		expect(getServerState().cpuFallback).toBeUndefined();
	});

	it('stopServer shows "stopped" once the sidecar stops', async () => {
		const { startServer, stopServer, getServerState } = await freshStore();
		await startServer('/models/a.gguf');
		await stopServer();
		expect(getServerState().status).toBe('stopped');
	});

	it('stopServer keeps the status and records the error when stopping fails', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				stop_server: () => {
					throw 'still busy';
				}
			})
		);
		const { startServer, stopServer, getServerState } = await freshStore();
		await startServer('/models/a.gguf');
		await stopServer();
		expect(getServerState().status).toBe('starting');
		expect(getServerState().errorMessage).toBe('still busy');
	});

	it('getServerLogs returns the server log lines', async () => {
		tauri.invoke.mockImplementation(invokeRouter({ get_server_logs: ['line 1', 'line 2'] }));
		const { getServerLogs } = await freshStore();
		expect(await getServerLogs()).toEqual(['line 1', 'line 2']);
	});

	it('getServerLogs returns empty array on error', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				get_server_logs: () => {
					throw new Error('not available');
				}
			})
		);
		const { getServerLogs } = await freshStore();
		expect(await getServerLogs()).toEqual([]);
	});
});

describe('status events', () => {
	it('initServerStore picks up the status the server already has', async () => {
		tauri.invoke.mockImplementation(invokeRouter({ get_server_status: { type: 'Ready' } }));
		const { initServerStore, getServerState } = await freshStore();
		await initServerStore();
		expect(getServerState().status).toBe('ready');
	});

	it('initServerStore leaves the status alone when the server cannot be asked', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				get_server_status: () => {
					throw 'not ready';
				}
			})
		);
		const { initServerStore, getServerState } = await freshStore();
		await initServerStore();
		expect(getServerState().status).toBe('stopped');
	});

	it('follows each lifecycle event the server sends', async () => {
		const { initServerStore, getServerState } = await freshStore();
		await initServerStore();

		emitStatus({ type: 'Starting' });
		expect(getServerState().status).toBe('starting');
		emitStatus({ type: 'Ready' });
		expect(getServerState().status).toBe('ready');
		emitStatus({ type: 'Stopped' });
		expect(getServerState().status).toBe('stopped');
	});

	it('shows the message of an Error event and clears it on the next event', async () => {
		const { initServerStore, getServerState } = await freshStore();
		await initServerStore();

		emitStatus({ type: 'Error', message: 'out of memory' });
		expect(getServerState()).toMatchObject({ status: 'error', errorMessage: 'out of memory' });

		emitStatus({ type: 'Starting' });
		expect(getServerState().status).toBe('starting');
		expect(getServerState().errorMessage).toBeUndefined();
	});

	it('keeps the remote badge when the idle local server reports Stopped', async () => {
		const { initServerStore, enterRemoteMode, getServerState } = await freshStore();
		await initServerStore();
		enterRemoteMode('http://gpu-box:8080/v1', 'qwen');

		emitStatus({ type: 'Stopped' });
		expect(getServerState().status).toBe('remote');
	});

	it('leaves remote mode for any status other than Stopped', async () => {
		const { initServerStore, enterRemoteMode, getServerState } = await freshStore();
		await initServerStore();
		enterRemoteMode('http://gpu-box:8080/v1', 'qwen');

		emitStatus({ type: 'Starting' });
		expect(getServerState().status).toBe('starting');
	});

	it('initServerStore attaches its listeners only once', async () => {
		const { initServerStore, getServerState } = await freshStore();
		await initServerStore();
		tauri.listeners.clear();
		tauri.invoke.mockImplementation(invokeRouter({ get_server_status: { type: 'Ready' } }));

		await initServerStore();
		expect(tauri.listeners.size).toBe(0);
		expect(getServerState().status).toBe('stopped');
	});
});

describe('restartServerWhenIdle', () => {
	it('restarts straight away when no inference is running', async () => {
		const { restartServerWhenIdle, getPendingRestart, getServerState } = await freshStore();
		await expect(restartServerWhenIdle('/models/b.gguf', 16384, 'model')).resolves.toBe(true);
		expect(starts()).toEqual([['/models/b.gguf', 16384]]);
		expect(getServerState().status).toBe('starting');
		expect(getPendingRestart()).toBeNull();
	});

	it('queues the restart while a turn is running instead of interrupting it', async () => {
		queue.running = 1;
		const { restartServerWhenIdle, getPendingRestart } = await freshStore();
		await expect(restartServerWhenIdle('/models/b.gguf', 16384, 'context')).resolves.toBe(false);
		expect(starts()).toEqual([]);
		expect(invokeCalls(tauri.invoke, 'stop_server')).toEqual([]);
		expect(getPendingRestart()).toEqual({
			modelPath: '/models/b.gguf',
			ctxSize: 16384,
			reason: 'context'
		});
	});

	it('a later request while busy replaces the queued one', async () => {
		queue.running = 1;
		const { restartServerWhenIdle, getPendingRestart } = await freshStore();
		await restartServerWhenIdle('/models/b.gguf', 8192, 'model');
		await restartServerWhenIdle('/models/c.gguf', 4096, 'parallel');
		expect(getPendingRestart()).toEqual({
			modelPath: '/models/c.gguf',
			ctxSize: 4096,
			reason: 'parallel'
		});
	});

	it('an immediate restart drops a restart queued earlier', async () => {
		queue.running = 1;
		const { restartServerWhenIdle, maybeFlushPendingRestart, getPendingRestart } =
			await freshStore();
		await restartServerWhenIdle('/models/old.gguf', 8192, 'model');

		queue.running = 0;
		await restartServerWhenIdle('/models/new.gguf', 8192, 'model');
		await maybeFlushPendingRestart();

		expect(getPendingRestart()).toBeNull();
		expect(starts()).toEqual([['/models/new.gguf', 8192]]);
	});

	it('cancelPendingRestart forgets the queued restart', async () => {
		queue.running = 1;
		const { restartServerWhenIdle, cancelPendingRestart, maybeFlushPendingRestart } =
			await freshStore();
		await restartServerWhenIdle('/models/b.gguf', 8192, 'model');
		cancelPendingRestart();

		queue.running = 0;
		await maybeFlushPendingRestart();
		expect(starts()).toEqual([]);
	});
});

describe('maybeFlushPendingRestart', () => {
	it('does nothing when no restart is queued', async () => {
		const { maybeFlushPendingRestart, getServerState } = await freshStore();
		await maybeFlushPendingRestart();
		expect(starts()).toEqual([]);
		expect(getServerState().status).toBe('stopped');
	});

	it('keeps waiting while inference is still running', async () => {
		queue.running = 2;
		const { restartServerWhenIdle, maybeFlushPendingRestart, getPendingRestart } =
			await freshStore();
		await restartServerWhenIdle('/models/b.gguf', 8192, 'model');

		queue.running = 1;
		await maybeFlushPendingRestart();
		expect(starts()).toEqual([]);
		expect(getPendingRestart()).not.toBeNull();
	});

	it('runs the queued restart once inference goes idle', async () => {
		queue.running = 1;
		const { restartServerWhenIdle, maybeFlushPendingRestart, getPendingRestart } =
			await freshStore();
		await restartServerWhenIdle('/models/b.gguf', 8192, 'model');

		queue.running = 0;
		await maybeFlushPendingRestart();
		expect(starts()).toEqual([['/models/b.gguf', 8192]]);
		expect(getPendingRestart()).toBeNull();
	});

	it('starts the server once even when the layout re-fires during a flush', async () => {
		let finishStop!: () => void;
		tauri.invoke.mockImplementation(
			invokeRouter({ stop_server: () => new Promise<void>((r) => (finishStop = r)) })
		);
		queue.running = 1;
		const { restartServerWhenIdle, maybeFlushPendingRestart } = await freshStore();
		await restartServerWhenIdle('/models/b.gguf', 8192, 'model');

		queue.running = 0;
		const first = maybeFlushPendingRestart();
		const second = maybeFlushPendingRestart();
		finishStop();
		await Promise.all([first, second]);
		expect(starts()).toEqual([['/models/b.gguf', 8192]]);
	});

	it('holds a restart queued mid-flush until that flush finishes, then runs it', async () => {
		let finishStop!: () => void;
		tauri.invoke.mockImplementation(
			invokeRouter({ stop_server: () => new Promise<void>((r) => (finishStop = r)) })
		);
		queue.running = 1;
		const { restartServerWhenIdle, maybeFlushPendingRestart, getPendingRestart } =
			await freshStore();
		await restartServerWhenIdle('/models/b.gguf', 8192, 'model');

		queue.running = 0;
		const first = maybeFlushPendingRestart();

		// A new turn starts and the user changes the context size meanwhile.
		queue.running = 1;
		await restartServerWhenIdle('/models/b.gguf', 4096, 'context');
		queue.running = 0;
		await maybeFlushPendingRestart();
		expect(getPendingRestart()).toMatchObject({ ctxSize: 4096 });

		finishStop();
		await first;
		expect(starts()).toEqual([['/models/b.gguf', 8192]]);

		tauri.invoke.mockImplementation(invokeRouter({}));
		await maybeFlushPendingRestart();
		expect(starts()).toEqual([
			['/models/b.gguf', 8192],
			['/models/b.gguf', 4096]
		]);
		expect(getPendingRestart()).toBeNull();
	});

	it('can flush again after a flush whose start failed', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				start_server: () => {
					throw 'boom';
				}
			})
		);
		queue.running = 1;
		const { restartServerWhenIdle, maybeFlushPendingRestart, getServerState } = await freshStore();
		await restartServerWhenIdle('/models/b.gguf', 8192, 'model');
		queue.running = 0;
		await maybeFlushPendingRestart();
		expect(getServerState().status).toBe('error');

		tauri.invoke.mockImplementation(invokeRouter({}));
		queue.running = 1;
		await restartServerWhenIdle('/models/c.gguf', 8192, 'model');
		queue.running = 0;
		await maybeFlushPendingRestart();
		expect(starts().at(-1)).toEqual(['/models/c.gguf', 8192]);
		expect(getServerState().status).toBe('starting');
	});
});

describe('remote mode label', () => {
	it.each([
		['http://gpu-box:8080/v1', 'qwen3-32b', 'qwen3-32b @ gpu-box:8080'],
		['https://api.example.com/v1', 'llama', 'llama @ api.example.com'],
		['http://gpu-box:8080/v1', '  ', 'gpu-box:8080'],
		['http://gpu-box:8080/v1', ' qwen ', 'qwen @ gpu-box:8080'],
		['not a url', 'qwen', 'qwen @ not a url'],
		['', 'qwen', 'qwen'],
		['', '', ''],
		['https://openrouter.ai/api/v1', 'anthropic/claude', 'anthropic/claude @ OpenRouter (cloud)'],
		['https://openrouter.ai/api/v1', '', 'OpenRouter (cloud)']
	])('%j with model %j reads %j', async (baseUrl, modelId, label) => {
		const { enterRemoteMode, getServerState } = await freshStore();
		enterRemoteMode(baseUrl, modelId);
		expect(getServerState().status).toBe('remote');
		expect(getServerState().remoteLabel).toBe(label);
	});

	it('does not call a look-alike host OpenRouter', async () => {
		const { enterRemoteMode, getServerState } = await freshStore();
		enterRemoteMode('https://openrouter.ai.evil.example/v1', 'm');
		expect(getServerState().remoteLabel).toBe('m @ openrouter.ai.evil.example');
	});

	it('exitRemoteMode clears the label and returns to stopped', async () => {
		const { enterRemoteMode, exitRemoteMode, getServerState } = await freshStore();
		enterRemoteMode('http://gpu-box:8080/v1', 'qwen');
		exitRemoteMode();
		expect(getServerState().status).toBe('stopped');
		expect(getServerState().remoteLabel).toBeUndefined();
	});
});
