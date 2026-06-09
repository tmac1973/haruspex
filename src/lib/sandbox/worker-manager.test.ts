import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MainToWorker, ToolResult, WorkerToMain } from './protocol';

// Worker-manager pulls in a few app singletons; stub them so the manager is
// exercised in isolation. getWorkingDir → null keeps the pre-run workdir sync
// a no-op (so runPython drives straight through to `send`).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('$lib/stores/session.svelte', () => ({ getWorkingDir: () => null }));
vi.mock('$lib/stores/settings', () => ({ getSettings: () => ({ proxy: { mode: 'none' } }) }));
vi.mock('$lib/debug-log', () => ({ logDebug: () => {} }));

import { WorkerManager } from './worker-manager';

/** Minimal Worker stand-in: captures postMessage and replays messages. */
class FakeWorker {
	posted: MainToWorker[] = [];
	private onMessage?: (e: MessageEvent<WorkerToMain>) => void;
	addEventListener(type: string, cb: EventListenerOrEventListenerObject): void {
		if (type === 'message') this.onMessage = cb as (e: MessageEvent<WorkerToMain>) => void;
	}
	postMessage(msg: MainToWorker): void {
		this.posted.push(msg);
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
	function makeManager(isolated = false) {
		fake = new FakeWorker();
		return new WorkerManager(() => fake as unknown as Worker, { isIsolated: () => isolated });
	}

	beforeEach(() => {
		vi.clearAllMocks();
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

	it('replies to a get_proxy_mode request with the current settings', async () => {
		const wm = makeManager();
		wm.runPython('x').catch(() => {}); // spawns the worker + registers the listener
		fake.emit({ kind: 'ready' });
		fake.emit({ kind: 'get_proxy_mode' });
		const reply = fake.posted.find((m) => m.kind === 'proxy_mode');
		expect(reply).toMatchObject({ kind: 'proxy_mode', mode: 'none', workingDirSet: false });
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
});
