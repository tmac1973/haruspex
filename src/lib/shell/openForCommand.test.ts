import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	sleep: vi.fn(),
	listen: vi.fn(),
	exitHandler: null as null | ((e: { payload: { session_id: number } }) => void)
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('#lib/utils/async.ts', () => ({ sleep: mocks.sleep }));

import { openForCommand, type OpenedSession, type OpenerDeps } from './openForCommand';

const PTY = 7;

/**
 * A shell tab whose pane binds its PTY on the second poll, and a PTY whose
 * counters move as the test says. `onTick` runs on every poll's sleep, which
 * is where the "user" acts.
 */
function setup(
	opts: {
		markers?: number;
		region?: { commandLine: string; output: string; exitCode: number | null };
		onTick?: (state: State, tick: number) => void;
	} = {}
) {
	const state: State = {
		bound: false,
		open: true,
		gone: false,
		markerTotal: opts.markers ?? 2,
		completedTotal: 0,
		writes: [],
		shown: []
	};
	const session: OpenedSession = {
		id: 'shell-3',
		name: 'Shell 3',
		initialCwd: null,
		get boundSessionId() {
			return state.bound ? PTY : null;
		}
	};
	const deps: OpenerDeps = {
		create: () => session,
		isOpen: () => state.open,
		show: (id) => state.shown.push(id)
	};
	let tick = 0;
	mocks.sleep.mockImplementation(async () => {
		tick += 1;
		if (tick === 1) state.bound = true;
		opts.onTick?.(state, tick);
	});
	mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		if (state.gone) throw new Error('shell session not found');
		switch (cmd) {
			case 'shell_get_context':
				return { completed_total: state.completedTotal, marker_total: state.markerTotal };
			case 'shell_write':
				state.writes.push(String(args?.data));
				return null;
			case 'shell_get_recent_commands':
				return [
					{
						...(opts.region ?? { commandLine: 'sudo dnf install foo', output: 'ok', exitCode: 0 }),
						cwd: '/proj',
						truncated: false
					}
				];
		}
		throw new Error(`unexpected ${cmd}`);
	});
	return { state, session, deps };
}

interface State {
	bound: boolean;
	open: boolean;
	gone: boolean;
	markerTotal: number;
	completedTotal: number;
	writes: string[];
	shown: string[];
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.exitHandler = null;
	mocks.listen.mockImplementation(async (_event: string, fn: typeof mocks.exitHandler) => {
		mocks.exitHandler = fn;
		return () => {};
	});
});

describe('openForCommand', () => {
	it('opens at the folder and pastes without Enter', async () => {
		const { state, session, deps } = setup();
		const onOpened = vi.fn();
		const res = await openForCommand(
			{ command: 'sudo dnf install foo', cwd: '/proj', wait: false, onOpened },
			deps
		);
		expect(session.initialCwd).toBe('/proj');
		expect(state.shown).toEqual(['shell-3']);
		expect(state.writes).toEqual(['\x1b[200~sudo dnf install foo\x1b[201~']);
		expect(state.writes[0]).not.toMatch(/[\r\n]$/);
		expect(res).toEqual({ kind: 'opened', shellName: 'Shell 3', integration: true });
		expect(onOpened).toHaveBeenCalledWith(expect.objectContaining({ name: 'Shell 3' }));
		onOpened.mock.calls[0][0].focus();
		expect(state.shown).toEqual(['shell-3', 'shell-3']);
	});

	it('returns the finished command as the result', async () => {
		const { deps } = setup({
			onTick: (s, t) => {
				if (t === 4) s.completedTotal = 1;
			},
			region: { commandLine: 'sudo dnf install foo', output: 'Installed.\n', exitCode: 0 }
		});
		const res = await openForCommand(
			{ command: 'sudo dnf install foo', cwd: '/proj', wait: true },
			deps
		);
		expect(res).toMatchObject({
			kind: 'completed',
			shellName: 'Shell 3',
			command: 'sudo dnf install foo',
			exitCode: 0,
			output: 'Installed.\n',
			cwd: '/proj'
		});
	});

	it('reports the command that ran when the user edited it', async () => {
		const { deps } = setup({
			onTick: (s, t) => {
				if (t === 3) s.completedTotal = 1;
			},
			region: { commandLine: 'sudo dnf install -y foo', output: '', exitCode: 1 }
		});
		const res = await openForCommand(
			{ command: 'sudo dnf install foo', cwd: '/proj', wait: true },
			deps
		);
		expect(res).toMatchObject({
			kind: 'completed',
			command: 'sudo dnf install -y foo',
			exitCode: 1
		});
	});

	it('is closed when the tab closes first', async () => {
		const { deps } = setup({
			onTick: (s, t) => {
				if (t === 3) {
					s.open = false;
					s.gone = true;
				}
			}
		});
		const res = await openForCommand({ command: 'ls', cwd: '/proj', wait: true }, deps);
		expect(res).toEqual({ kind: 'closed', shellName: 'Shell 3' });
	});

	it('is closed when the shell exits', async () => {
		const { deps } = setup({
			onTick: (_s, t) => {
				if (t === 3) mocks.exitHandler?.({ payload: { session_id: PTY } });
			}
		});
		const res = await openForCommand({ command: 'ls', cwd: '/proj', wait: true }, deps);
		expect(res).toEqual({ kind: 'closed', shellName: 'Shell 3' });
	});

	it('keeps waiting through a detach: the PTY still answers', async () => {
		const { deps } = setup({
			onTick: (s, t) => {
				if (t === 3) s.open = false;
				if (t === 5) s.completedTotal = 1;
			}
		});
		const res = await openForCommand({ command: 'ls', cwd: '/proj', wait: true }, deps);
		expect(res.kind).toBe('completed');
	});

	it('stops waiting on abort and leaves the tab alone', async () => {
		const abort = new AbortController();
		const { state, deps } = setup({
			onTick: (_s, t) => {
				if (t === 4) abort.abort();
			}
		});
		const res = await openForCommand(
			{ command: 'ls', cwd: '/proj', wait: true, signal: abort.signal },
			deps
		);
		expect(res).toEqual({ kind: 'aborted', shellName: 'Shell 3' });
		expect(state.open).toBe(true);
		expect(mocks.invoke).not.toHaveBeenCalledWith('shell_kill', expect.anything());
	});

	it('returns at once when the shell sends no markers', async () => {
		const { state, deps } = setup({ markers: 0 });
		const now = vi.spyOn(Date, 'now');
		let t = 0;
		now.mockImplementation(() => (t += 1000));
		const res = await openForCommand({ command: 'ls', cwd: '/proj', wait: true }, deps);
		now.mockRestore();
		expect(res).toEqual({ kind: 'opened', shellName: 'Shell 3', integration: false });
		expect(state.writes).toEqual(['\x1b[200~ls\x1b[201~']);
	});
});
