import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Isolate the store from the Tauri boundary and the agent turn machinery —
// here we're testing the registry + per-session state independence, not the
// inference pipeline.
vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockResolvedValue(undefined)
}));

const runShellTurn = vi.hoisted(() => vi.fn());
vi.mock('#lib/shell/runShellTurn.ts', () => ({ runShellTurn }));

// The builder echoes the mode and the repo's instructions so a test can see
// them arrive.
vi.mock('#lib/shell/system-prompt.ts', () => ({
	buildShellSystemPrompt: (opts: { projectInstructions?: string; fullAccess?: boolean }) => ({
		role: 'system',
		content: `${opts.fullAccess ? 'full-sys' : 'sys'}${opts.projectInstructions ?? ''}`
	})
}));

const bridge = vi.hoisted(() => ({ openCodeAt: vi.fn(async (root: string) => void root) }));
vi.mock('#lib/code/bridge.ts', () => bridge);

vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => ({
		shellFullAccessDefault: false,
		codeMaxIterations: 40,
		maxResponseTokensFileWrite: 65536,
		shellHistoryTurnsForPrompt: 3,
		shellMaxBytesPerCapture: 1000,
		contextSize: 8192,
		inferenceBackend: { mode: 'local' },
		skills: { extraDirs: [], disabled: [], autonomous: 'auto', trustedRepos: {} }
	}),
	// Read by resolveBackendDescriptor, which the shell store now uses for
	// the turn's context size.
	getActiveLocalModelFilename: () => '',
	getApiKeyValue: () => undefined
}));

vi.mock('#lib/agent/tools/index.ts', () => ({ getDisplayLabel: () => 'tool' }));
// Repo trust and AGENTS.md have their own tests (skills/turn.test.ts); here the
// shell is outside any trusted repo unless a test says otherwise, so no turn
// waits on the trust prompt.
const project = vi.hoisted(() => ({
	shellProject: vi.fn<(cwd: string | null) => Promise<{ root: string | null; agentsMd: unknown }>>(
		async () => ({ root: null, agentsMd: null })
	),
	setRepoTrusted: vi.fn(),
	knownShellProject: vi.fn<
		(cwd: string | null) => Promise<{ root: string | null; agentsMd: unknown }>
	>(async () => ({ root: null, agentsMd: null }))
}));
vi.mock('#lib/skills/project.ts', () => project);
// Wrapped, not replaced, so a test can see which repo's skills a turn asked for.
const skillsTurn = vi.hoisted(() => ({ prepareTurnSkills: vi.fn() }));
vi.mock('#lib/skills/turn.ts', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/skills/turn.ts')>();
	skillsTurn.prepareTurnSkills.mockImplementation(real.prepareTurnSkills);
	return { ...real, prepareTurnSkills: skillsTurn.prepareTurnSkills };
});
vi.mock('#lib/agent/context-budget.ts', () => ({ describeContextManaged: () => 'managed' }));
vi.mock('#lib/debug-log.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debug-log.ts')>()),
	logDebug: vi.fn()
}));

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
} from '#lib/stores/shell.svelte.ts';
import {
	approveSession,
	isSessionApproved,
	resetSessionApproval,
	SHELL_APPROVAL_KEY
} from '#lib/stores/codeCommandApproval.svelte.ts';
import { setPtyBusy } from '#lib/stores/shellPtyBusy.svelte.ts';
import type { ChatMessage } from '#lib/api.ts';

beforeEach(() => {
	// Drain the module-level registry between tests.
	for (const s of [...getShellSessions()]) closeShellSession(s.id);
	runShellTurn.mockReset();
	runShellTurn.mockImplementation(async (opts: { onAdmitted?: () => void }) => {
		opts.onAdmitted?.();
		return { finalText: 'done', rawText: 'done' };
	});
	vi.mocked(invoke).mockClear();
	resetSessionApproval(SHELL_APPROVAL_KEY);
});

describe('command approval', () => {
	it('newChat re-arms the per-command approval ("allow for session" does not leak)', () => {
		const s = createShellSession();
		approveSession(SHELL_APPROVAL_KEY);
		expect(isSessionApproved(SHELL_APPROVAL_KEY)).toBe(true);
		s.newChat();
		expect(isSessionApproved(SHELL_APPROVAL_KEY)).toBe(false);
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

	it('sends a /name skill between the shell activity and the question', async () => {
		installInvoke({ completedTotal: 1, recentLimits: [] });
		const s = createShellSession();
		bindCtx(s, 11);
		const skill = {
			name: 'triage',
			body: 'Check the logs first.',
			dir: null,
			compatibility: null,
			files: [],
			filesTruncated: false
		};
		await s.submitChatMessage('/triage nginx is down', [], skill);
		const content = String(s.messages[0].content);
		expect(content.indexOf('Recent shell activity')).toBeLessThan(
			content.indexOf('<skill_content name="triage">')
		);
		expect(content.endsWith('/triage nginx is down')).toBe(true);
	});

	it('adds a /skills note without a turn', () => {
		const s = createShellSession();
		s.addLocalNote('Skills you can run: …');
		expect(s.messages).toEqual([{ role: 'assistant', content: 'Skills you can run: …' }]);
		expect(runShellTurn).not.toHaveBeenCalled();
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
 * Typing into the shell mid-turn can corrupt the agent's next command, but the
 * block has to be narrow: while the agent's command is actually running, the
 * user's keystrokes are the only way to answer a sudo/[y/N]/credential prompt.
 */
describe('terminal input blocking', () => {
	function fullAccessSession() {
		const s = new ShellSession('shell-1', 'Shell 1');
		s.fullAccess = true;
		s.bindSession({ sessionId: 42 } as never);
		return s;
	}

	afterEach(() => setPtyBusy(42, null));

	it('blocks while a Full-access turn is between commands', () => {
		const s = fullAccessSession();
		s.isSubmitting = true;
		expect(s.terminalInputBlocked).toBe(true);
	});

	it('allows input while the agent command is running, so prompts can be answered', () => {
		const s = fullAccessSession();
		s.isSubmitting = true;
		setPtyBusy(42, 'sudo apt install foo');
		expect(s.terminalInputBlocked).toBe(false);
	});

	it('never blocks in Read-only', () => {
		const s = fullAccessSession();
		s.fullAccess = false;
		s.isSubmitting = true;
		expect(s.terminalInputBlocked).toBe(false);
	});

	it('never blocks when no turn is in flight', () => {
		const s = fullAccessSession();
		expect(s.terminalInputBlocked).toBe(false);
	});

	it('releases as soon as the turn ends', () => {
		const s = fullAccessSession();
		s.isSubmitting = true;
		expect(s.terminalInputBlocked).toBe(true);
		s.isSubmitting = false;
		expect(s.terminalInputBlocked).toBe(false);
	});
});

describe('outgoing prompt shape', () => {
	it("folds an adopted chat thread's handoff note into the system prompt", async () => {
		const s = createShellSession();
		s.adoptChatThread([
			{ role: 'system', content: '[moved here from the Chat tab]' },
			{ role: 'user', content: 'how do I free disk space?' },
			{ role: 'assistant', content: 'run du' }
		]);

		await s.submitShell({
			body: 'do it',
			sessionContext: {} as never,
			currentCwd: '/home',
			recentHistory: []
		});

		const sent = runShellTurn.mock.calls[0][0].messages as ChatMessage[];
		// Exactly one system message, and it still carries the note: vLLM 400s
		// with "System message must be at the beginning." on two in a row.
		expect(sent.filter((m) => m.role === 'system')).toHaveLength(1);
		expect(sent[0].role).toBe('system');
		expect(sent[0].content).toBe('sys\n\n[moved here from the Chat tab]');
		// The sidebar still renders the note as its own entry.
		expect(s.messages[0].role).toBe('system');
	});
});

describe('AGENTS.md in the Shell assistant', () => {
	const md = {
		files: ['AGENTS.md'],
		text: 'From AGENTS.md:\nRun make check.',
		truncated: false,
		totalBytes: 31
	};
	const submit = (s: ReturnType<typeof createShellSession>) =>
		s.submitShell({
			body: 'run the tests',
			sessionContext: {} as never,
			currentCwd: '/code/repo/src',
			recentHistory: []
		});

	it("carries the trusted repo's instructions and shows them in the sidebar", async () => {
		project.shellProject.mockResolvedValueOnce({ root: '/code/repo', agentsMd: md });
		const s = createShellSession();
		s.fullAccess = true;
		await submit(s);

		expect(project.shellProject).toHaveBeenCalledWith('/code/repo/src');
		const sent = runShellTurn.mock.calls.at(-1)![0].messages as ChatMessage[];
		expect(String(sent[0].content)).toContain('Run make check.');
		expect(s.agentsMd).toEqual(md);
	});

	it('stops using the repo from the badge, for every later turn', async () => {
		project.shellProject.mockResolvedValueOnce({ root: '/code/repo', agentsMd: md });
		const s = createShellSession();
		await submit(s);
		expect(s.projectRoot).toBe('/code/repo');

		s.ignoreProject();
		expect(project.setRepoTrusted).toHaveBeenCalledWith('/code/repo', false);
		expect(s.agentsMd).toBeNull();
		expect(s.projectRoot).toBeNull();
	});

	it('shows the AGENTS.md a turn wrote without waiting for the next turn', async () => {
		const s = createShellSession();
		s.fullAccess = true;
		project.knownShellProject.mockResolvedValueOnce({ root: '/code/repo', agentsMd: md });
		// The agent loop appends the turn's tool calls to the messages it was given.
		runShellTurn.mockImplementationOnce(async (opts: { messages: ChatMessage[] }) => {
			const call = {
				id: 'a',
				type: 'function',
				function: { name: 'write_agents_md', arguments: '{}' }
			};
			opts.messages.push(
				{ role: 'assistant', content: '', tool_calls: [call] } as ChatMessage,
				{ role: 'tool', content: 'Saved.', tool_call_id: 'a' } as ChatMessage
			);
			return { finalText: 'done', rawText: 'done' };
		});
		await submit(s);
		await vi.waitFor(() => expect(s.agentsMd).toEqual(md));
		expect(project.knownShellProject).toHaveBeenCalledOnce();
		expect(s.projectRoot).toBe('/code/repo');
	});

	it("doesn't look again after a turn that left AGENTS.md alone", async () => {
		const s = createShellSession();
		project.knownShellProject.mockClear();
		await submit(s);
		expect(project.knownShellProject).not.toHaveBeenCalled();
	});

	it('carries them in the troubleshooting assistant too, without project skills', async () => {
		project.shellProject.mockResolvedValueOnce({ root: '/code/repo', agentsMd: md });
		const s = createShellSession();
		s.fullAccess = false;
		await submit(s);

		const sent = runShellTurn.mock.calls.at(-1)![0].messages as ChatMessage[];
		expect(String(sent[0].content)).toContain('Run make check.');
		expect(s.agentsMd).toEqual(md);
		expect(skillsTurn.prepareTurnSkills).toHaveBeenLastCalledWith({
			projectRoot: null,
			codeMode: false
		});
	});
});

describe('Read-only and Full access', () => {
	const submit = (s: ShellSession) =>
		s.submitShell({
			body: 'fix it',
			sessionContext: {} as never,
			currentCwd: '/code/repo',
			recentHistory: []
		});

	it('starts from the Settings → Shell default', () => {
		expect(createShellSession().fullAccess).toBe(false);
	});

	it('Full access runs the Shell code profile with the shell prompt', async () => {
		const s = createShellSession();
		s.fullAccess = true;
		await submit(s);
		const opts = runShellTurn.mock.calls.at(-1)![0];
		// The registry's Shell code profile: the tool set Code mode had.
		expect(opts.codeMode).toBe(true);
		expect(opts.maxIterations).toBe(40);
		expect(opts.maxResponseTokens).toBe(65536);
		expect((opts.messages as ChatMessage[])[0].content).toBe('full-sys');
	});

	it('Read-only runs the plain shell profile', async () => {
		const s = createShellSession();
		await submit(s);
		const opts = runShellTurn.mock.calls.at(-1)![0];
		expect(opts.codeMode).toBe(false);
		expect(opts.maxIterations).toBeUndefined();
		expect((opts.messages as ChatMessage[])[0].content).toBe('sys');
	});

	it('toggling re-arms "approve for this session"', () => {
		const s = createShellSession();
		approveSession(SHELL_APPROVAL_KEY);
		s.toggleFullAccess();
		expect(s.fullAccess).toBe(true);
		expect(isSessionApproved(SHELL_APPROVAL_KEY)).toBe(false);
	});

	it('saves nothing: no database call after a turn', async () => {
		const s = createShellSession();
		s.fullAccess = true;
		s.bindSession({ sessionId: 7 } as never);
		vi.mocked(invoke).mockClear();
		await submit(s);
		const commands = vi.mocked(invoke).mock.calls.map((c) => c[0]);
		expect(commands.filter((c) => c.startsWith('db_'))).toEqual([]);
	});

	it('a shell moved between windows keeps its mode', () => {
		const s = reattachShellSession(77, 'Shell', true);
		expect(s?.fullAccess).toBe(true);
		const t = reattachShellSession(78, 'Shell');
		expect(t?.fullAccess).toBe(false);
	});
});

describe('Open in Code', () => {
	beforeEach(() => bridge.openCodeAt.mockClear());

	it('opens a Code session at the folder the terminal is in now', async () => {
		const s = createShellSession();
		s.bindSession({ sessionId: 5 } as never);
		vi.mocked(invoke).mockImplementation(async (cmd: string) =>
			cmd === 'shell_get_context'
				? ({ current_cwd: '/home/tim/app', completed_total: 0 } as never)
				: (undefined as never)
		);
		await s.openInCode();
		expect(bridge.openCodeAt).toHaveBeenCalledWith('/home/tim/app', null);
		// The shell thread stays here.
		expect(s.messages).toEqual([]);
		vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
	});

	it("says so when the shell hasn't reported a folder", async () => {
		const s = createShellSession();
		await expect(s.openInCode()).rejects.toThrow('folder');
		expect(bridge.openCodeAt).not.toHaveBeenCalled();
	});
});
