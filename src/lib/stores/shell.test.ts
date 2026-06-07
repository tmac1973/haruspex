import { describe, it, expect, beforeEach, vi } from 'vitest';

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
		shellAllowWrite: false,
		shellHistoryTurnsForPrompt: 0,
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

beforeEach(() => {
	// Drain the module-level registry between tests.
	for (const s of [...getShellSessions()]) closeShellSession(s.id);
	runShellTurn.mockReset();
	runShellTurn.mockImplementation(async (opts: { onAdmitted?: () => void }) => {
		opts.onAdmitted?.();
		return { finalText: 'done' };
	});
	vi.mocked(invoke).mockClear();
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

describe('detach / re-attach', () => {
	function bind(session: ShellSession, ptyId: number) {
		session.bindSession({ sessionId: ptyId, context: {} as never, getSelection: () => '' });
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
