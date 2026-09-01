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
	buildShellSystemPrompt: () => ({ role: 'system', content: 'sys' }),
	// Code mode picks this builder instead; needed by the persistence tests,
	// which all run with codeMode on.
	buildShellCodeSystemPrompt: () => ({ role: 'system', content: 'code-sys' })
}));

vi.mock('$lib/stores/settings', () => ({
	getSettings: () => ({
		shellCodeModeDefault: false,
		shellHistoryTurnsForPrompt: 3,
		shellMaxBytesPerCapture: 1000,
		contextSize: 8192,
		inferenceBackend: { mode: 'local' }
	}),
	// Read by resolveBackendDescriptor, which the shell store now uses for
	// the turn's context size.
	getActiveLocalModelFilename: () => '',
	getApiKeyValue: () => undefined
}));

const dbMock = vi.hoisted(() => ({
	dbSaveShellSession: vi.fn(async () => {}),
	dbLoadShellSession: vi.fn<(cwd: string) => Promise<string | null>>(async () => null),
	dbDeleteShellSession: vi.fn(async () => {})
}));
vi.mock('$lib/stores/db', () => dbMock);

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
import { setPtyBusy } from '$lib/stores/shellPtyBusy.svelte';

beforeEach(() => {
	// Drain the module-level registry between tests.
	for (const s of [...getShellSessions()]) closeShellSession(s.id);
	runShellTurn.mockReset();
	runShellTurn.mockImplementation(async (opts: { onAdmitted?: () => void }) => {
		opts.onAdmitted?.();
		return { finalText: 'done', rawText: 'done' };
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
				return { finalText: 'answer', rawText: 'answer', stopReason: 'max_iterations' };
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
				return { finalText: 'continued', rawText: 'continued', stopReason: 'complete' };
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

describe('rendered-thread trimming', () => {
	it('bounds the thread: older turns trimmed behind a note, recent window + tool pairs kept', async () => {
		// Every turn appends a tool_call/result pair before the prose answer —
		// 4 entries per turn, like a Code-mode session.
		runShellTurn.mockImplementation(
			async (opts: { messages: { role: string }[]; onAdmitted?: () => void }) => {
				opts.onAdmitted?.();
				opts.messages.push(
					{ role: 'assistant', content: '', tool_calls: [{ id: 'c' }] } as never,
					{ role: 'tool', tool_call_id: 'c', content: 'out' } as never
				);
				return { finalText: 'answer', rawText: 'answer', stopReason: 'complete' };
			}
		);
		const s = createShellSession();
		// 16 turns × 4 entries: crosses the 40-entry cap at turn 10 and again at
		// turn 16, so the final state is freshly trimmed: one note + the last 8
		// prose bubbles (4 exchanges) with their interleaved tool pairs.
		for (let i = 0; i < 16; i++) {
			await s.submitShell({
				body: `q${i}`,
				sessionContext: {} as never,
				currentCwd: '/',
				recentHistory: []
			});
		}

		expect(s.messages[0].role).toBe('system');
		expect(String(s.messages[0].content)).toContain('trimmed');
		const prose = s.messages.filter(
			(m) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls)
		);
		expect(prose).toHaveLength(8);
		// Tool pairs inside the kept window survive (Continue replays them)…
		expect(s.messages.some((m) => m.role === 'tool')).toBe(true);
		// …and the thread is bounded instead of 16 × 4 = 64 entries.
		expect(s.messages).toHaveLength(17);
		// The newest turn is intact at the tail.
		expect(s.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'answer' });
	});

	it('never trims a short session', async () => {
		const s = createShellSession();
		for (let i = 0; i < 5; i++) {
			await s.submitShell({
				body: `q${i}`,
				sessionContext: {} as never,
				currentCwd: '/',
				recentHistory: []
			});
		}
		expect(s.messages.every((m) => m.role !== 'system')).toBe(true);
		expect(s.messages).toHaveLength(10);
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
	// observe the limits shell_get_recent_commands is called with. When
	// `state.pending` is set, the mock appends an in-flight region the way the
	// backend's capture_recent_commands_with_pending does — so a query asked
	// mid-`ssh`-session still has the session scrollback attached.
	function installInvoke(state: {
		completedTotal: number;
		recentLimits: number[];
		pending?: string;
		pendingFroms?: number[];
	}) {
		vi.mocked(invoke).mockImplementation((async (
			cmd: string,
			args?: { limit: number; pendingFrom?: number }
		) => {
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
				case 'shell_get_recent_commands': {
					state.recentLimits.push(args!.limit);
					const regions = Array.from({ length: args!.limit }, () => ({
						commandLine: 'cat hangman.py',
						output: 'print("x")',
						exitCode: 0 as number | null,
						cwd: '/home/tim',
						truncated: false,
						pending: false,
						outputStart: 0,
						outputEnd: 0
					}));
					if (state.pending !== undefined) {
						// Stand in for the Rust watermark slice: offsets are string
						// indices here, and the backend returns only what has arrived
						// since `pendingFrom`.
						const from = args?.pendingFrom ?? 0;
						state.pendingFroms?.push(from);
						regions.push({
							commandLine: 'ssh server',
							output: state.pending.slice(from),
							exitCode: null,
							cwd: '/home/tim',
							truncated: false,
							pending: true,
							outputStart: from,
							outputEnd: state.pending.length
						});
					}
					return regions;
				}
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

		// Turn 2: nothing new finished → the backend is still polled (limit 0, to
		// catch any in-flight command), but with no pending region it returns
		// nothing, so no completed commands are re-attached — just the question.
		await s.submitChatMessage('what about now?');
		expect(state.recentLimits).toEqual([2, 0]);
		expect(s.messages[2].content).toBe('what about now?');

		// Turn 3: one more command finished → attach only that new one.
		state.completedTotal = 3;
		await s.submitChatMessage('and now?');
		expect(state.recentLimits).toEqual([2, 0, 1]); // min(limit, 3 - 2) = 1
		expect(s.messages[4].content).toContain('Recent shell activity');
	});

	it('attaches an in-flight command (e.g. an ssh session) even when none completed', async () => {
		// User is sitting inside `ssh server`: no command has *completed* since
		// the last attach, but the in-flight session's scrollback is exactly what
		// the question is about. It must still be attached.
		const state = {
			completedTotal: 2,
			recentLimits: [] as number[],
			pending: 'remote-host$ uname -a\nLinux remote-host 6.1.0\n'
		};
		installInvoke(state);
		const s = createShellSession();
		bindCtx(s, 12);

		await s.submitChatMessage('connecting...');
		expect(state.recentLimits).toEqual([2]);
		const q1 = s.messages[0].content;
		expect(q1).toContain('Recent shell activity');
		expect(q1).toContain('ssh server');
		expect(q1).toContain('Linux remote-host');
		expect(q1).toContain('still running, no exit code yet');
	});

	it('sends only remote output that arrived since the last turn', async () => {
		// An ssh session is ONE command whose output grows for as long as it
		// runs. Re-sending all of it every turn spent the capture budget on a
		// transcript already in the chat history — and since the budget trim is
		// head+tail, the recent work being asked about was what got squeezed.
		const state = {
			completedTotal: 2,
			recentLimits: [] as number[],
			pendingFroms: [] as number[],
			pending: 'BusyBox v1.36 (OpenWrt)\n'
		};
		installInvoke(state);
		const s = createShellSession();
		bindCtx(s, 13);

		await s.submitChatMessage('what box is this?');
		expect(state.pendingFroms).toEqual([0]);
		expect(s.messages[0].content).toContain('BusyBox v1.36');

		// The remote emits more while the user reads the answer.
		const banner = state.pending;
		state.pending += 'root@OpenWrt:~# dmesg | tail\nusb 1-1: new device\n';
		await s.submitChatMessage('anything in dmesg?');
		expect(state.pendingFroms).toEqual([0, banner.length]);
		const q2 = s.messages[2].content;
		expect(q2).toContain('usb 1-1: new device');
		// The banner is already in the thread from turn 1 — not re-sent.
		expect(q2).not.toContain('BusyBox v1.36');

		// Nothing new since: no shell-activity block at all, just the question.
		await s.submitChatMessage('still nothing?');
		expect(s.messages[4].content).toBe('still nothing?');
	});

	it('re-sends the in-flight command in full for an explicit context dump', async () => {
		// "Submit context" is the user saying "send what is on screen NOW", so it
		// ignores the watermark the way it already ignores the completed-command one.
		const state = {
			completedTotal: 2,
			recentLimits: [] as number[],
			pendingFroms: [] as number[],
			pending: 'BusyBox v1.36 (OpenWrt)\n'
		};
		installInvoke(state);
		const s = createShellSession();
		bindCtx(s, 14);

		await s.submitChatMessage('what box is this?');
		await s.submitRecentCommands();
		expect(state.pendingFroms).toEqual([0, 0]);
		expect(s.messages[2].content).toContain('BusyBox v1.36');
	});

	it('resets the in-flight watermark when the thread is cleared', async () => {
		const state = {
			completedTotal: 2,
			recentLimits: [] as number[],
			pendingFroms: [] as number[],
			pending: 'BusyBox v1.36 (OpenWrt)\n'
		};
		installInvoke(state);
		const s = createShellSession();
		bindCtx(s, 15);

		await s.submitChatMessage('what box is this?');
		// A new thread carries none of the old history, so the in-flight output
		// has to go out from the start again.
		s.newChat();
		await s.submitChatMessage('what box is this?');
		expect(state.pendingFroms).toEqual([0, 0]);
		expect(s.messages[0].content).toContain('BusyBox v1.36');
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

/**
 * Code-mode threads persist so a coding session survives a crash or power
 * loss. The shell tab is otherwise session-scoped on purpose, so the guards
 * on WHEN a restore is allowed are the part worth pinning down.
 */
/**
 * Typing into the shell mid-turn can corrupt the agent's next command, but the
 * block has to be narrow: while the agent's command is actually running, the
 * user's keystrokes are the only way to answer a sudo/[y/N]/credential prompt.
 */
describe('terminal input blocking', () => {
	function codeSession() {
		const s = new ShellSession('shell-1', 'Shell 1');
		s.codeMode = true;
		s.bindSession({ sessionId: 42 } as never);
		return s;
	}

	afterEach(() => setPtyBusy(42, null));

	it('blocks while a code-mode turn is between commands', () => {
		const s = codeSession();
		s.isSubmitting = true;
		expect(s.terminalInputBlocked).toBe(true);
	});

	it('allows input while the agent command is running, so prompts can be answered', () => {
		const s = codeSession();
		s.isSubmitting = true;
		setPtyBusy(42, 'sudo apt install foo');
		expect(s.terminalInputBlocked).toBe(false);
	});

	it('never blocks outside code mode', () => {
		const s = codeSession();
		s.codeMode = false;
		s.isSubmitting = true;
		expect(s.terminalInputBlocked).toBe(false);
	});

	it('never blocks when no turn is in flight', () => {
		const s = codeSession();
		expect(s.terminalInputBlocked).toBe(false);
	});

	it('releases as soon as the turn ends', () => {
		const s = codeSession();
		s.isSubmitting = true;
		expect(s.terminalInputBlocked).toBe(true);
		s.isSubmitting = false;
		expect(s.terminalInputBlocked).toBe(false);
	});
});

describe('code-mode session persistence', () => {
	const encoded = JSON.stringify({
		version: 1,
		savedAt: 1,
		messages: [
			{ role: 'user', content: 'earlier question' },
			{ role: 'assistant', content: 'earlier answer' }
		],
		messageSteps: {},
		messageStats: {},
		messageStops: {},
		messageHistorySent: {}
	});

	beforeEach(() => {
		dbMock.dbLoadShellSession.mockReset().mockResolvedValue(encoded);
		dbMock.dbSaveShellSession.mockReset();
		dbMock.dbDeleteShellSession.mockReset();
	});

	it('restores a stored thread into an empty code-mode session', async () => {
		const s = new ShellSession('shell-1', 'Shell 1');
		s.codeMode = true;
		await s.restoreCodeThread('/home/tim/projects/haruspex');
		expect(s.messages).toHaveLength(2);
		expect(s.restoredNotice).toEqual({ turns: 1, cwd: '/home/tim/projects/haruspex' });
		// The user should land on the conversation, not an empty panel.
		expect(s.sidebarOpen).toBe(true);
	});

	it('never restores over a thread the user is already in', async () => {
		const s = new ShellSession('shell-1', 'Shell 1');
		s.codeMode = true;
		s.messages = [{ role: 'user', content: 'live question' }];
		await s.restoreCodeThread('/work');
		expect(s.messages).toEqual([{ role: 'user', content: 'live question' }]);
		expect(s.restoredNotice).toBeNull();
	});

	it('does not restore outside code mode', async () => {
		const s = new ShellSession('shell-1', 'Shell 1');
		s.codeMode = false;
		await s.restoreCodeThread('/work');
		expect(dbMock.dbLoadShellSession).not.toHaveBeenCalled();
		expect(s.messages).toHaveLength(0);
	});

	it('does not restore without a known cwd', async () => {
		const s = new ShellSession('shell-1', 'Shell 1');
		s.codeMode = true;
		await s.restoreCodeThread(null);
		expect(dbMock.dbLoadShellSession).not.toHaveBeenCalled();
	});

	it('"Start fresh" forgets the stored thread; newChat keeps it', async () => {
		const s = new ShellSession('shell-1', 'Shell 1');
		s.codeMode = true;
		await s.restoreCodeThread('/work');

		s.newChat();
		expect(s.messages).toHaveLength(0);
		expect(s.restoredNotice).toBeNull();
		// newChat clears the live thread only — the stored one stays restorable.
		expect(dbMock.dbDeleteShellSession).not.toHaveBeenCalled();

		await s.restoreCodeThread('/work');
		s.startFreshCodeThread();
		expect(s.messages).toHaveLength(0);
		expect(dbMock.dbDeleteShellSession).toHaveBeenCalledWith('/work');
	});

	it('keeps the thread when the notice is dismissed', async () => {
		const s = new ShellSession('shell-1', 'Shell 1');
		s.codeMode = true;
		await s.restoreCodeThread('/work');
		s.dismissRestoredNotice();
		expect(s.restoredNotice).toBeNull();
		expect(s.messages).toHaveLength(2);
	});

	/**
	 * The bug this pins: a new PTY opens in $HOME, but threads are saved under
	 * whatever project directory the user cd'd into. Checking only at
	 * terminal-bind always asked about $HOME, so nothing ever came back.
	 */
	/**
	 * Bind a terminal that has no context yet — the realistic mount state, and
	 * deterministic here: `bindSession` kicks off its own status refresh, so
	 * letting it see a cwd would race the awaited poll the test drives.
	 */
	async function bindWithoutContext(s: ShellSession) {
		vi.mocked(invoke).mockRejectedValue(new Error('no pty yet'));
		s.bindSession({ sessionId: 1 } as never);
		await s.refreshIntegrationStatus();
	}

	/** Point the live shell at `cwd` for the next `refreshIntegrationStatus`. */
	function atCwd(cwd: string) {
		vi.mocked(invoke).mockResolvedValue({
			current_cwd: cwd,
			marker_count: 0,
			completed_commands: 0,
			completed_total: 0
		} as never);
	}

	/** Only `savedIn` has a stored thread — every other directory is empty. */
	function savedOnlyIn(savedIn: string) {
		dbMock.dbLoadShellSession.mockImplementation(async (cwd: string) =>
			cwd === savedIn ? encoded : null
		);
	}

	/**
	 * The bug this pins: a new PTY opens in $HOME, but threads are saved under
	 * whatever project directory the user cd'd into. Checking only at
	 * terminal-bind always asked about $HOME, so nothing ever came back.
	 */
	it('restores when the shell reaches the saved directory, not just at startup', async () => {
		const s = new ShellSession('shell-1', 'Shell 1');
		s.codeMode = true;
		savedOnlyIn('/home/tim/test');

		await bindWithoutContext(s);

		// Shell comes up in $HOME — nothing saved there.
		atCwd('/home/tim');
		await s.refreshIntegrationStatus();
		expect(s.messages).toHaveLength(0);
		expect(s.restoredNotice).toBeNull();

		// User cds into the project the thread belongs to. The poll dispatches
		// the restore without awaiting it — a status tick must not block on a
		// database read — so settle rather than assuming it lands synchronously.
		atCwd('/home/tim/test');
		await s.refreshIntegrationStatus();
		await vi.waitFor(() => expect(s.messages).toHaveLength(2));
		expect(s.restoredNotice?.cwd).toBe('/home/tim/test');
	});

	it('checks each directory once, not on every poll tick', async () => {
		const s = new ShellSession('shell-1', 'Shell 1');
		s.codeMode = true;
		savedOnlyIn('/elsewhere');
		await bindWithoutContext(s);
		atCwd('/somewhere');
		for (let i = 0; i < 5; i++) await s.refreshIntegrationStatus();
		expect(dbMock.dbLoadShellSession).toHaveBeenCalledTimes(1);
		expect(dbMock.dbLoadShellSession).toHaveBeenCalledWith('/somewhere');
	});

	it('does not resurrect a thread the user just cleared', async () => {
		const s = new ShellSession('shell-1', 'Shell 1');
		s.codeMode = true;
		savedOnlyIn('/work');
		await bindWithoutContext(s);
		atCwd('/work');
		await s.refreshIntegrationStatus();
		await vi.waitFor(() => expect(s.messages).toHaveLength(2));

		// newChat leaves the row on disk on purpose; the poll must not undo it.
		s.newChat();
		await s.refreshIntegrationStatus();
		await s.refreshIntegrationStatus();
		expect(s.messages).toHaveLength(0);
	});

	it('retires the notice once a message is sent, so Start fresh cannot eat new work', async () => {
		const s = new ShellSession('shell-1', 'Shell 1');
		s.codeMode = true;
		savedOnlyIn('/work');
		await bindWithoutContext(s);
		atCwd('/work');
		await s.refreshIntegrationStatus();
		await vi.waitFor(() => expect(s.restoredNotice).not.toBeNull());

		await s.submitShell({
			body: 'next question',
			currentCwd: '/work',
			recentHistory: [],
			capturedRegions: []
		} as never);

		expect(s.restoredNotice).toBeNull();
		// The restored context is still there — only the banner went away.
		expect(s.messages.length).toBeGreaterThan(2);
	});

	it('refuses Start fresh mid-turn rather than half-applying it', async () => {
		const s = new ShellSession('shell-1', 'Shell 1');
		s.codeMode = true;
		savedOnlyIn('/work');
		await bindWithoutContext(s);
		atCwd('/work');
		await s.refreshIntegrationStatus();
		await vi.waitFor(() => expect(s.messages).toHaveLength(2));

		s.isSubmitting = true;
		s.startFreshCodeThread();
		// newChat refuses mid-turn, so deleting the row here would strand the
		// thread on screen with nothing backing it.
		expect(dbMock.dbDeleteShellSession).not.toHaveBeenCalled();
		expect(s.messages).toHaveLength(2);
	});

	it('ignores a stored thread it cannot decode', async () => {
		dbMock.dbLoadShellSession.mockResolvedValue('{corrupt');
		const s = new ShellSession('shell-1', 'Shell 1');
		s.codeMode = true;
		await s.restoreCodeThread('/work');
		expect(s.messages).toHaveLength(0);
		expect(s.restoredNotice).toBeNull();
	});
});
