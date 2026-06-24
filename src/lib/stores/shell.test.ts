import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Isolate the store from the Tauri boundary and the agent turn machinery —
// here we're testing the registry + per-session state independence, not the
// inference pipeline.
vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockResolvedValue(undefined)
}));

const runShellTurn = vi.hoisted(() => vi.fn());
vi.mock('$lib/shell/runShellTurn', () => ({ runShellTurn }));

vi.mock('$lib/shell/system-prompt', () => ({
	buildShellSystemPrompt: () => ({ role: 'system', content: 'sys' })
}));

vi.mock('$lib/stores/settings', () => ({
	getSettings: () => ({
		shellCodeModeDefault: false,
		shellHistoryTurnsForPrompt: 3,
		shellMaxBytesPerCapture: 1000
	}),
	getActiveContextSize: () => 8192
}));

vi.mock('$lib/agent/tools', () => ({ getDisplayLabel: () => 'tool' }));
vi.mock('$lib/agent/context-budget', () => ({ describeContextManaged: () => 'managed' }));
vi.mock('$lib/debug-log', () => ({ logDebug: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import {
	ShellSession,
	createShellSession,
	closeShellSession,
	detachShellSession,
	reattachShellSession,
	setActiveShell,
	getShellSessions,
	getActiveShellSession,
	getActiveShellId,
	ensureShellSession
} from '$lib/stores/shell.svelte';
import {
	approveSession,
	isSessionApproved,
	resetSessionApproval
} from '$lib/stores/codeCommandApproval.svelte';

beforeEach(() => {
	// Drain the module-level registry between tests.
	for (const s of [...getShellSessions()]) closeShellSession(s.id);
	runShellTurn.mockReset();
	runShellTurn.mockImplementation(async (opts: { onAdmitted?: () => void }) => {
		opts.onAdmitted?.();
		return { finalText: 'done' };
	});
	vi.mocked(invoke).mockClear();
	resetSessionApproval();
});

describe('command approval', () => {
	it('newChat re-arms the per-command approval ("allow for session" does not leak)', () => {
		const s = createShellSession();
		approveSession();
		expect(isSessionApproved()).toBe(true);
		s.newChat();
		expect(isSessionApproved()).toBe(false);
	});
});

describe('shell registry', () => {
	it('creates sessions with monotonic names and activates the newest', () => {
		const a = createShellSession();
		const b = createShellSession();
		expect(getShellSessions()).toHaveLength(2);
		expect(a.name).not.toBe(b.name);
		expect(getActiveShellId()).toBe(b.id);
		expect(getActiveShellSession()).toBe(b);
	});

	it('switches the active session', () => {
		const a = createShellSession();
		createShellSession();
		setActiveShell(a.id);
		expect(getActiveShellSession()).toBe(a);
	});

	it('ignores setActiveShell for unknown ids', () => {
		const a = createShellSession();
		setActiveShell('does-not-exist');
		expect(getActiveShellSession()).toBe(a);
	});

	it('closing the active session activates a neighbour', () => {
		const a = createShellSession();
		const b = createShellSession();
		const c = createShellSession();
		setActiveShell(b.id);
		closeShellSession(b.id);
		expect(getShellSessions().map((s) => s.id)).toEqual([a.id, c.id]);
		// Neighbour at the same index (c) takes over.
		expect(getActiveShellId()).toBe(c.id);
	});

	it('ensureShellSession reuses the active one or creates the first', () => {
		expect(getShellSessions()).toHaveLength(0);
		const first = ensureShellSession();
		expect(getShellSessions()).toHaveLength(1);
		expect(ensureShellSession()).toBe(first);
	});
});

describe('ShellSession state independence', () => {
	it('keeps sidebar/chat state separate per session', () => {
		const a = createShellSession();
		const b = createShellSession();
		a.setSidebarOpen(true);
		expect(a.sidebarOpen).toBe(true);
		expect(b.sidebarOpen).toBe(false);

		a.messages = [{ role: 'user', content: 'hi' }];
		expect(b.messages).toHaveLength(0);
	});

	it('newChat clears the thread', () => {
		const a = new ShellSession('shell-x', 'Shell X');
		a.messages = [{ role: 'user', content: 'hi' }];
		a.lastError = 'boom';
		a.newChat();
		expect(a.messages).toHaveLength(0);
		expect(a.lastError).toBeNull();
	});

	it('submitShell appends user+assistant turns and only touches its own session', async () => {
		const a = createShellSession();
		const b = createShellSession();
		await a.submitShell({
			body: 'why is disk full?',
			sessionContext: {} as never,
			currentCwd: '/home',
			recentHistory: []
		});
		expect(runShellTurn).toHaveBeenCalledTimes(1);
		expect(a.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(a.isSubmitting).toBe(false);
		expect(b.messages).toHaveLength(0);
	});

	it('retains the loop-appended tool_call/result pairs and replays them next turn', async () => {
		// Simulate runAgentLoop mutating the passed `messages` array in place:
		// after the user turn it appends an assistant tool_call + its tool result
		// (plus a synthetic "answer now" nudge that must NOT be persisted).
		runShellTurn.mockImplementation(
			async (opts: { messages: { role: string }[]; onAdmitted?: () => void }) => {
				opts.onAdmitted?.();
				opts.messages.push(
					{ role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] } as never,
					{ role: 'tool', tool_call_id: 'c1', content: 'grep hit' } as never,
					{ role: 'user', content: 'Now please provide your complete answer.' } as never
				);
				return { finalText: 'answer', stopReason: 'max_iterations' };
			}
		);
		const s = createShellSession();
		await s.submitShell({
			body: 'find the bug',
			sessionContext: {} as never,
			currentCwd: '/home',
			recentHistory: []
		});

		// The tool pairs are kept (between user and prose); the nudge is dropped.
		expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
		expect(s.messages[1].tool_calls).toBeDefined();
		// Stats/stops are keyed to the prose message's final index (3), not 1.
		expect(s.messageStops[3]).toBe('max_iterations');

		// Second turn ("continue") must see the prior turn's tool pairs in the
		// messages handed to the loop — proving the model can resume its work.
		let seenRoles: string[] = [];
		runShellTurn.mockImplementation(
			async (opts: { messages: { role: string }[]; onAdmitted?: () => void }) => {
				opts.onAdmitted?.();
				seenRoles = opts.messages.map((m) => m.role);
				return { finalText: 'continued', stopReason: 'complete' };
			}
		);
		await s.submitShell({
			body: 'Please continue from where you stopped.',
			sessionContext: {} as never,
			currentCwd: '/home',
			recentHistory: []
		});
		// system + (user, assistant-tool_calls, tool, assistant) + new user.
		expect(seenRoles).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
	});

	it('submitShell is a no-op while a turn is already running', async () => {
		const a = createShellSession();
		a.isSubmitting = true;
		await a.submitShell({
			body: 'x',
			sessionContext: {} as never,
			currentCwd: null,
			recentHistory: []
		});
		expect(runShellTurn).not.toHaveBeenCalled();
	});
});

describe('command auto-attach de-duplication', () => {
	function bindCtx(session: ShellSession, sessionId: number) {
		session.bindSession({
			sessionId,
			context: {} as never,
			getSelection: () => '',
			restart: async () => {},
			serialize: () => ''
		});
	}

	// Drives invoke by command name so we can vary completed_total per turn and
	// observe whether shell_get_recent_commands gets called (i.e. an attach).
	function installInvoke(state: { completedTotal: number; recentLimits: number[] }) {
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { limit: number }) => {
			switch (cmd) {
				case 'shell_get_context':
					return {
						context: {},
						current_cwd: '/home/tim',
						marker_count: 9,
						completed_commands: 2,
						completed_total: state.completedTotal
					};
				case 'shell_get_recent_history':
					return [];
				case 'shell_get_recent_commands':
					state.recentLimits.push(args!.limit);
					return Array.from({ length: args!.limit }, () => ({
						commandLine: 'cat hangman.py',
						output: 'print("x")',
						exitCode: 0,
						cwd: '/home/tim',
						truncated: false
					}));
				default:
					return undefined;
			}
		}) as never);
	}

	afterEach(() => {
		vi.mocked(invoke).mockReset();
		vi.mocked(invoke).mockResolvedValue(undefined);
	});

	it('attaches captured commands once, then not again until new ones finish', async () => {
		const state = { completedTotal: 2, recentLimits: [] as number[] };
		installInvoke(state);
		const s = createShellSession();
		bindCtx(s, 11);

		// Turn 1: 2 commands finished → attach (capped at the limit of 3 → 2).
		await s.submitChatMessage('what tools do you have available?');
		expect(state.recentLimits).toEqual([2]);
		expect(s.messages[0].content).toContain('Recent shell activity');
		expect(s.messages[0].content).toContain('what tools do you have available?');

		// Turn 2: nothing new finished → no re-attach, just the bare question.
		await s.submitChatMessage('what about now?');
		expect(state.recentLimits).toEqual([2]); // shell_get_recent_commands NOT called again
		expect(s.messages[2].content).toBe('what about now?');

		// Turn 3: one more command finished → attach only that new one.
		state.completedTotal = 3;
		await s.submitChatMessage('and now?');
		expect(state.recentLimits).toEqual([2, 1]); // min(limit, 3 - 2) = 1
		expect(s.messages[4].content).toContain('Recent shell activity');
	});
});

describe('detach / re-attach', () => {
	function bind(session: ShellSession, ptyId: number) {
		session.bindSession({
			sessionId: ptyId,
			context: {} as never,
			getSelection: () => '',
			restart: async () => {},
			serialize: () => ''
		});
	}

	it('closeShellSession kills the bound PTY', () => {
		const a = createShellSession();
		bind(a, 42);
		closeShellSession(a.id);
		expect(invoke).toHaveBeenCalledWith('shell_kill', { sessionId: 42 });
		expect(getShellSessions()).toHaveLength(0);
	});

	it('detachShellSession removes the tab WITHOUT killing the PTY', () => {
		const a = createShellSession();
		const b = createShellSession();
		bind(b, 7);
		detachShellSession(b.id);
		expect(invoke).not.toHaveBeenCalledWith('shell_kill', expect.anything());
		expect(getShellSessions().map((s) => s.id)).toEqual([a.id]);
		expect(getActiveShellId()).toBe(a.id);
	});

	it('reattachShellSession adds an attach-mode session and takes its chat', () => {
		const s = reattachShellSession(99, 'Shell 99');
		expect(s).not.toBeNull();
		expect(s!.attachPtyId).toBe(99);
		expect(getActiveShellSession()).toBe(s);
		expect(invoke).toHaveBeenCalledWith('shell_take_chat', { sessionId: 99 });
	});

	it('reattachShellSession is idempotent for a PTY already present', () => {
		reattachShellSession(99);
		const second = reattachShellSession(99);
		expect(second).toBeNull();
		expect(getShellSessions().filter((s) => s.attachPtyId === 99)).toHaveLength(1);
	});
});
