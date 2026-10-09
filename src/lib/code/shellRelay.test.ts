import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellCommandOpener, ShellCommandRequest, ShellCommandResult } from './shellBridge';
import {
	SHELL_ABORT_EVENT,
	SHELL_OPEN_EVENT,
	createShellRelay,
	serveShellRelay,
	type RelayBus
} from './shellRelay';

/** Tauri's event system in miniature: every emit reaches every listener, later. */
function fakeBus() {
	const listeners = new Map<string, Set<(p: unknown) => void>>();
	const sent: { label: string; event: string; payload: unknown }[] = [];
	const bus: RelayBus = {
		async emitTo(label, event, payload) {
			sent.push({ label, event, payload });
			const copy = JSON.parse(JSON.stringify(payload));
			queueMicrotask(() => listeners.get(event)?.forEach((cb) => cb(copy)));
		},
		async listen(event, cb) {
			const set = listeners.get(event) ?? new Set();
			set.add(cb as (p: unknown) => void);
			listeners.set(event, set);
			return () => set.delete(cb as (p: unknown) => void);
		}
	};
	return { bus, sent };
}

/** The main window's opener, held until the test settles it. */
function heldOpener() {
	let req!: ShellCommandRequest;
	let settle!: (r: ShellCommandResult) => void;
	const open = vi.fn<ShellCommandOpener>();
	const called = new Promise<ShellCommandRequest>((resolve) => {
		open.mockImplementation((r: ShellCommandRequest) => {
			req = r;
			resolve(r);
			return new Promise<ShellCommandResult>((s) => (settle = s));
		});
	});
	return {
		open,
		called,
		get req() {
			return req;
		},
		settle: (r: ShellCommandResult) => settle(r)
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('open_in_shell from a detached Code window', () => {
	it('opens the shell in the main window, raises it, and brings the result back', async () => {
		const { bus, sent } = fakeBus();
		const main = heldOpener();
		const raise = vi.fn();
		await serveShellRelay(bus, main.open, raise);
		const relay = createShellRelay(bus, 'code-s1');

		const opened = vi.fn();
		const pending = relay({ command: 'sudo dnf up', cwd: '/proj', wait: true, onOpened: opened });
		const req = await main.called;
		expect(req).toMatchObject({ command: 'sudo dnf up', cwd: '/proj', wait: true });
		expect(raise).toHaveBeenCalled();
		expect(sent[0]).toMatchObject({ label: 'main', event: SHELL_OPEN_EVENT });

		// The tab exists: the detached side hears its name.
		const focusTab = vi.fn();
		req.onOpened?.({ name: 'Shell 2', focus: focusTab });
		await vi.waitFor(() => expect(opened).toHaveBeenCalled());
		expect(opened.mock.calls[0][0].name).toBe('Shell 2');

		// "Go to shell" from the detached window shows the tab and raises main.
		raise.mockClear();
		opened.mock.calls[0][0].focus();
		await vi.waitFor(() => expect(focusTab).toHaveBeenCalled());
		expect(raise).toHaveBeenCalled();

		const result: ShellCommandResult = {
			kind: 'completed',
			shellName: 'Shell 2',
			command: 'sudo dnf up',
			exitCode: 0,
			output: 'Complete!',
			cwd: '/proj',
			durationMs: 1200
		};
		main.settle(result);
		expect(await pending).toEqual(result);
		// Answers go to the window that asked.
		expect(sent.filter((m) => m.event !== SHELL_OPEN_EVENT).map((m) => m.label)).toEqual(
			expect.arrayContaining(['code-s1'])
		);
	});

	it('carries Cancel or Stop to the main window, which ends its wait', async () => {
		const { bus, sent } = fakeBus();
		const main = heldOpener();
		await serveShellRelay(bus, main.open, () => {});
		const relay = createShellRelay(bus, 'code-s1');
		const abort = new AbortController();
		const pending = relay({ command: 'sudo x', cwd: '/p', wait: true, signal: abort.signal });
		const req = await main.called;
		req.onOpened?.({ name: 'Shell 3', focus: () => {} });
		await vi.waitFor(() => expect(sent.some((m) => m.event === 'code://shell-opened')).toBe(true));

		abort.abort();
		// The detached side doesn't wait for the round trip.
		expect(await pending).toEqual({ kind: 'aborted', shellName: 'Shell 3' });
		expect(sent.find((m) => m.event === SHELL_ABORT_EVENT)?.label).toBe('main');
		await vi.waitFor(() => expect(req.signal?.aborted).toBe(true));
		main.settle({ kind: 'aborted', shellName: 'Shell 3' });
	});

	it('drops a request whose abort arrives before it does', async () => {
		const { bus } = fakeBus();
		const open = vi.fn<ShellCommandOpener>();
		await serveShellRelay(bus, open, () => {});
		// The abort overtakes the request on the way.
		await bus.emitTo('main', SHELL_ABORT_EVENT, { reqId: 'code-s1:9' });
		await new Promise((r) => setTimeout(r, 0));
		await bus.emitTo('main', SHELL_OPEN_EVENT, {
			reqId: 'code-s1:9',
			from: 'code-s1',
			command: 'x',
			cwd: '/p',
			wait: true
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(open).not.toHaveBeenCalled();
	});

	it('returns aborted at once for a signal that already fired', async () => {
		const { bus, sent } = fakeBus();
		const relay = createShellRelay(bus, 'code-s1');
		const abort = new AbortController();
		abort.abort();
		expect(await relay({ command: 'x', cwd: '/p', wait: true, signal: abort.signal })).toEqual({
			kind: 'aborted',
			shellName: ''
		});
		expect(sent).toEqual([]);
	});

	it('says so when the main window never answers', async () => {
		vi.useFakeTimers();
		const { bus } = fakeBus();
		const relay = createShellRelay(bus, 'code-s1', { ackTimeoutMs: 1000 });
		const pending = relay({ command: 'x', cwd: '/p', wait: false });
		await vi.advanceTimersByTimeAsync(1000);
		expect(await pending).toMatchObject({ kind: 'unavailable' });
	});

	it('passes a failure in the main window back as unavailable', async () => {
		const { bus } = fakeBus();
		await serveShellRelay(
			bus,
			async () => Promise.reject(new Error('no pty')),
			() => {}
		);
		const relay = createShellRelay(bus, 'code-s1');
		expect(await relay({ command: 'x', cwd: '/p', wait: false })).toEqual({
			kind: 'unavailable',
			message: 'no pty'
		});
	});

	it('keeps concurrent requests from two windows apart', async () => {
		const { bus } = fakeBus();
		await serveShellRelay(
			bus,
			async (req) => ({ kind: 'opened', shellName: req.command, integration: true }),
			() => {}
		);
		const a = createShellRelay(bus, 'code-a');
		const b = createShellRelay(bus, 'code-b');
		const [ra, rb] = await Promise.all([
			a({ command: 'A', cwd: '/p', wait: false }),
			b({ command: 'B', cwd: '/p', wait: false })
		]);
		expect(ra).toMatchObject({ shellName: 'A' });
		expect(rb).toMatchObject({ shellName: 'B' });
	});
});
