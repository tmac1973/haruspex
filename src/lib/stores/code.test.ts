import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentLoopOptions } from '#lib/agent/loop.ts';
import type { ChatMessage } from '#lib/api.ts';

// The Tauri boundary is an in-memory `code_sessions` table, so a session can
// be saved, closed and loaded back by id as the app would.
const db = vi.hoisted(() => {
	const rows = new Map<string, Record<string, unknown>>();
	// The Rust claim map, as seen from the window these tests run in ('main').
	const owners = new Map<string, string>();
	const handoffs = new Map<string, string>();
	const alive = new Set<string>(['main']);
	// Phase 7b: who holds the folder, what others changed, and git per folder.
	const folders = {
		holder: null as string | null,
		notices: [] as unknown[],
		git: new Map<string, unknown>()
	};
	let n = 0;
	const emptyThread = JSON.stringify({
		version: 1,
		savedAt: 0,
		messages: [],
		messageSteps: {},
		messageStats: {},
		messageStops: {},
		messageHistorySent: {}
	});
	return {
		rows,
		owners,
		handoffs,
		alive,
		folders,
		reset() {
			folders.holder = null;
			folders.notices = [];
			folders.git.clear();
			rows.clear();
			owners.clear();
			handoffs.clear();
			alive.clear();
			alive.add('main');
			n = 0;
		},
		handle(cmd: string, args: Record<string, unknown> = {}): unknown {
			switch (cmd) {
				case 'code_session_create': {
					n += 1;
					const row = {
						id: `s${n}`,
						title: '',
						root: args.root,
						backend: args.backend ?? null,
						reasoning_effort: args.effort ?? null,
						thread: emptyThread,
						forked_from: null,
						forked_at: null,
						created_at: n,
						updated_at: n
					};
					rows.set(row.id, row);
					return { ...row };
				}
				case 'code_session_load': {
					const row = rows.get(args.id as string);
					if (!row) throw new Error('no such session');
					return { ...row };
				}
				case 'code_session_save': {
					const row = rows.get(args.id as string)!;
					row.thread = args.thread;
					if (args.title != null) row.title = args.title;
					return undefined;
				}
				case 'code_session_update_meta': {
					const row = rows.get(args.id as string)!;
					const patch = args.patch as Record<string, unknown>;
					if ('title' in patch) row.title = patch.title;
					if ('backend' in patch) row.backend = patch.backend;
					if ('effort' in patch) row.reasoning_effort = patch.effort;
					return undefined;
				}
				case 'code_bg_status':
					return [];
				default:
					return this.windows(cmd, args);
			}
		},
		/** Fork, delete and the claim map: what phase 7 added. */
		windows(cmd: string, args: Record<string, unknown>): unknown {
			switch (cmd) {
				case 'code_session_fork': {
					const src = rows.get(args.id as string)!;
					const at = args.at as number;
					const thread = JSON.parse(src.thread as string);
					if (at > thread.messages.length) throw new Error('past the end');
					const cut = (m: Record<string, unknown>) =>
						Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => Number(k) < at));
					n += 1;
					const row = {
						...src,
						id: `s${n}`,
						title: `${src.title} (fork)`.trim(),
						thread: JSON.stringify({
							...thread,
							messages: thread.messages.slice(0, at),
							messageSteps: cut(thread.messageSteps),
							messageStats: cut(thread.messageStats),
							messageStops: cut(thread.messageStops)
						}),
						forked_from: src.id,
						forked_at: at,
						root: args.mode === 'worktree' ? `/wt/s${n}` : src.root,
						read_only: args.mode !== 'worktree',
						worktree: args.mode === 'worktree' ? `/wt/s${n}` : null
					};
					rows.set(row.id, row);
					return { ...row };
				}
				case 'code_session_delete':
					rows.delete(args.id as string);
					return undefined;
				case 'code_lease_take':
					return folders.holder;
				case 'code_notices_take': {
					const notices = folders.notices;
					folders.notices = [];
					return { notices, now: 99 };
				}
				case 'code_git_status':
					return folders.git.get(args.folder as string) ?? null;
				case 'code_git_worktree_remove':
					return { kind: 'removed' };
				case 'code_session_claim': {
					const id = args.id as string;
					const owner = owners.get(id);
					if (owner && owner !== 'main' && alive.has(owner)) return { owner, handoff: null };
					owners.set(id, 'main');
					const handoff = handoffs.get(id) ?? null;
					handoffs.delete(id);
					return { owner: null, handoff };
				}
				case 'code_session_release': {
					const id = args.id as string;
					const owner = owners.get(id);
					if (owner && owner !== 'main') return undefined;
					owners.delete(id);
					if (args.handoff) handoffs.set(id, args.handoff as string);
					return undefined;
				}
				default:
					return undefined;
			}
		}
	};
});

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	runAgentLoop: vi.fn(),
	withInferenceSlot: vi.fn(),
	nameSession: vi.fn(),
	watchHandlers: new Map<string, () => void>(),
	completedWatches: [] as { id: string }[],
	takeCodeWatches: vi.fn((owner: string): unknown[] => {
		void owner;
		return [];
	}),
	adoptCodeWatches: vi.fn(),
	raised: [] as string[],
	consumeWatches: vi.fn(),
	clearCodeWatches: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
	WebviewWindow: {
		getByLabel: async (label: string) => ({
			unminimize: async () => {},
			setFocus: async () => {
				mocks.raised.push(label);
			}
		})
	}
}));
vi.mock('#lib/agent/loop.ts', () => ({ runAgentLoop: mocks.runAgentLoop }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: mocks.withInferenceSlot
}));
vi.mock('#lib/code/sessionTitle.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/code/sessionTitle.ts')>()),
	nameSession: mocks.nameSession
}));
vi.mock('#lib/agent/tools/index.ts', () => ({ getDisplayLabel: () => 'tool' }));
vi.mock('#lib/skills/project.ts', () => ({
	shellProject: async () => ({ root: null, agentsMd: null })
}));
vi.mock('#lib/skills/turn.ts', () => ({
	prepareTurnSkills: async () => ({ catalog: [], projectRoot: null }),
	skillsPromptSection: () => ''
}));
vi.mock('#lib/inference/descriptor.ts', () => ({
	resolveBackendDescriptor: () => ({ contextSize: 8192 })
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => ({
		codeMaxIterations: 40,
		codeAutoApprove: false,
		maxResponseTokensFileWrite: 8192,
		codeRunCommandTimeoutSecs: 30,
		imageBackendKind: 'none',
		customSystemPrompt: ''
	})
}));
vi.mock('#lib/shell/backgroundWatch.ts', () => ({
	setCodeWatchCompletionHandler: (owner: string, fn: () => void) => {
		mocks.watchHandlers.set(owner, fn);
		return () => mocks.watchHandlers.delete(owner);
	},
	peekCompletedCodeWatches: () => mocks.completedWatches,
	buildWatchNotification: async () => 'A background command you started with watch has finished.',
	consumeWatches: (ids: string[]) => {
		mocks.consumeWatches(ids);
		mocks.completedWatches = mocks.completedWatches.filter((w) => !ids.includes(w.id));
	},
	clearCodeWatches: mocks.clearCodeWatches,
	takeCodeWatches: mocks.takeCodeWatches,
	adoptCodeWatches: (list: { id: string }[]) => {
		mocks.adoptCodeWatches(list);
		mocks.completedWatches.push(...list);
	}
}));
vi.mock('#lib/debug-log.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debug-log.ts')>()),
	logDebug: () => {}
}));

import {
	closeSession,
	deleteSession,
	forkAndOpen,
	forkSession,
	getActiveSession,
	getOpenSessions,
	handOffSession,
	newSession,
	openSession
} from '#lib/stores/code.svelte.ts';
import { decodeCodeSession } from '#lib/code/session.ts';
import { reportShellWait } from '#lib/code/shellBridge.ts';
import {
	approveSession,
	codeApprovalKey,
	isSessionApproved
} from '#lib/stores/codeCommandApproval.svelte.ts';

function chunk(content: string) {
	return { delta: { content } } as unknown as Parameters<AgentLoopOptions['onStreamChunk']>[0];
}

/** A turn that answers `text` at once. */
function answers(text: string) {
	return async (o: AgentLoopOptions) => {
		o.onStreamChunk(chunk(text));
		o.onComplete();
	};
}

/** A turn that waits for `release()` before answering. */
function held() {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let started!: (o: AgentLoopOptions) => void;
	const running = new Promise<AgentLoopOptions>((r) => (started = r));
	const impl = async (o: AgentLoopOptions) => {
		started(o);
		await gate;
		o.onStreamChunk(chunk('done'));
		o.onComplete();
	};
	return { impl, release, running };
}

function storedThread(id: string) {
	return decodeCodeSession(db.rows.get(id)!.thread as string);
}

beforeEach(async () => {
	for (const s of [...getOpenSessions()]) await closeSession(s.id);
	db.reset();
	mocks.invoke
		.mockReset()
		.mockImplementation(async (cmd: string, args?: Record<string, unknown>) =>
			db.handle(cmd, args)
		);
	mocks.runAgentLoop.mockReset().mockImplementation(answers('ok'));
	mocks.withInferenceSlot
		.mockReset()
		.mockImplementation(async (o: { onAdmitted?: () => void }, fn: () => Promise<unknown>) => {
			o.onAdmitted?.();
			return fn();
		});
	mocks.nameSession.mockReset().mockResolvedValue('Find where x lives');
	mocks.completedWatches = [];
	mocks.consumeWatches.mockReset();
	mocks.clearCodeWatches.mockReset();
	mocks.takeCodeWatches.mockReset().mockReturnValue([]);
	mocks.adoptCodeWatches.mockReset();
	mocks.raised = [];
});

describe('a Code session', () => {
	it('runs a turn, saves it, and loads back the same thread by id', async () => {
		const s = await newSession('/proj');
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			const c: ChatMessage = {
				role: 'assistant',
				content: '',
				tool_calls: [
					{ id: 'c1', type: 'function', function: { name: 'code_grep', arguments: '{}' } }
				]
			};
			o.onToolStart({ id: 'c1', name: 'code_grep', arguments: {} });
			o.messages.push(c, { role: 'tool', tool_call_id: 'c1', content: 'src/a.ts:1: x' });
			o.onToolEnd({ id: 'c1', name: 'code_grep', arguments: {} }, 'src/a.ts:1: x');
			o.onStreamChunk(chunk('Found it.'));
			o.onComplete();
		});
		await s.send('where is x defined?');

		expect(s.status).toBe('idle');
		expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
		expect(s.messageSteps[3]).toHaveLength(1);
		expect(storedThread(s.id)?.messages).toEqual(s.messages);

		await closeSession(s.id);
		const again = (await openSession(s.id))!;
		expect(again).not.toBe(s);
		expect(again.messages).toEqual(s.messages);
		expect(again.messageSteps).toEqual(s.messageSteps);
		expect(again.title).toBe('Find where x lives');
	});

	it('opens a session with an empty thread as an empty session', async () => {
		const s = await newSession('/proj');
		await closeSession(s.id);
		const again = (await openSession(s.id))!;
		expect(again.messages).toEqual([]);
		expect(again.root).toBe('/proj');
	});

	it('focuses a session that is already open instead of loading it again', async () => {
		const s = await newSession('/proj');
		await newSession('/other');
		expect(await openSession(s.id)).toBe(s);
		expect(getActiveSession()).toBe(s);
		expect(getOpenSessions()).toHaveLength(2);
	});

	it('names itself once, after its first turn, on its own backend', async () => {
		const backend = { baseUrl: 'http://box:8080', modelId: 'qwen' };
		const s = await newSession('/proj', { backend });
		await s.send('fix the build');
		expect(mocks.nameSession).toHaveBeenCalledTimes(1);
		expect(mocks.nameSession).toHaveBeenCalledWith('fix the build', backend);
		expect(mocks.runAgentLoop).toHaveBeenCalledTimes(1);
		expect(s.title).toBe('Find where x lives');
		expect(db.rows.get(s.id)!.title).toBe('Find where x lives');
		await s.send('something else');
		expect(mocks.nameSession).toHaveBeenCalledTimes(1);
		expect(s.title).toBe('Find where x lives');
	});

	it('stays unnamed while it has only had slash commands', async () => {
		const s = await newSession('/proj');
		await s.send('/init');
		await s.send('  /review the diff');
		expect(mocks.nameSession).not.toHaveBeenCalled();
		expect(s.title).toBe('');
		expect(db.rows.get(s.id)!.title).toBe('');
		await s.send('now add a test');
		expect(mocks.nameSession).toHaveBeenCalledExactlyOnceWith('now add a test', null);
		expect(s.title).toBe('Find where x lives');
	});

	it('never overwrites a name the user gave it', async () => {
		const s = await newSession('/proj');
		await s.rename('Lint fixes');
		await s.send('fix the lint');
		expect(mocks.nameSession).not.toHaveBeenCalled();
		expect(s.title).toBe('Lint fixes');
	});

	it('keeps a rename made while the naming call runs', async () => {
		const s = await newSession('/proj');
		let answer!: (t: string) => void;
		mocks.nameSession.mockReturnValueOnce(new Promise<string>((r) => (answer = r)));
		const sending = s.send('fix the lint');
		await vi.waitFor(() => expect(mocks.nameSession).toHaveBeenCalled());
		await s.rename('Mine');
		answer('Model title');
		await sending;
		expect(s.title).toBe('Mine');
		expect(db.rows.get(s.id)!.title).toBe('Mine');
	});

	it('treats a saved title from a slash command as no title', async () => {
		const s = await newSession('/proj');
		db.rows.get(s.id)!.title = '/init';
		await closeSession(s.id);
		const again = (await openSession(s.id))!;
		expect(again.title).toBe('');
		await again.send('add a readme');
		expect(mocks.nameSession).toHaveBeenCalledExactlyOnceWith('add a readme', null);
		expect(db.rows.get(s.id)!.title).toBe('Find where x lives');
	});

	it('queues messages sent during a turn as steering for the loop', async () => {
		const s = await newSession('/proj');
		const turn = held();
		mocks.runAgentLoop.mockImplementationOnce(turn.impl);
		const sending = s.send('run the tests');
		const o = await turn.running;
		await s.send('only the unit ones');
		expect(s.steering).toEqual(['only the unit ones']);
		expect(o.takeSteering!()).toEqual(['only the unit ones']);
		expect(s.steering).toEqual([]);
		turn.release();
		await sending;
		expect(mocks.runAgentLoop).toHaveBeenCalledTimes(1);
	});

	it('hands back steering the turn never delivered', async () => {
		const s = await newSession('/proj');
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) =>
			o.onComplete({ stopReason: 'max_iterations', undeliveredSteering: ['and lint'] })
		);
		await s.send('go');
		expect(s.takeReturnedSteering()).toEqual(['and lint']);
		expect(s.returnedSteering).toEqual([]);
		expect(s.messageStops[1]).toBe('max_iterations');
	});

	it('saves the finished part of a stopped turn', async () => {
		const s = await newSession('/proj');
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			o.messages.push(
				{
					role: 'assistant',
					content: '',
					tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }]
				},
				{ role: 'tool', tool_call_id: 'c1', content: 'r' }
			);
			o.onStreamChunk(chunk('Now I will'));
			await new Promise<void>((resolve) =>
				o.signal!.addEventListener('abort', () => resolve(), { once: true })
			);
			throw new DOMException('Aborted', 'AbortError');
		});
		const sending = s.send('refactor it');
		await vi.waitFor(() => expect(mocks.runAgentLoop).toHaveBeenCalled());
		s.stop();
		await sending;
		expect(s.lastError).toBe('Stopped.');
		const saved = storedThread(s.id)!.messages;
		expect(saved.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
		expect(saved[3].content).toBe('Now I will');
	});

	it('shows queued while waiting for an inference slot', async () => {
		const s = await newSession('/proj');
		let admit!: () => void;
		mocks.withInferenceSlot.mockImplementationOnce(
			async (
				o: { onTicket?: (t: unknown) => void; onAdmitted?: () => void },
				fn: () => Promise<unknown>
			) => {
				o.onTicket?.({ id: 'main:1', consumer: 'code', state: 'waiting', enqueuedAt: 0 });
				await new Promise<void>((r) => (admit = r));
				o.onAdmitted?.();
				return fn();
			}
		);
		const sending = s.send('hi');
		await vi.waitFor(() => expect(s.status).toBe('queued'));
		expect(s.ticket).not.toBeNull();
		admit();
		await sending;
		expect(s.status).toBe('idle');
		expect(s.ticket).toBeNull();
	});

	it('shows waiting-shell while open_in_shell waits, then runs on', async () => {
		const s = await newSession('/proj');
		const turn = held();
		mocks.runAgentLoop.mockImplementationOnce(turn.impl);
		const sending = s.send('install it');
		await turn.running;
		expect(s.status).toBe('running');
		const focus = vi.fn();
		const cancel = vi.fn();
		reportShellWait(s.id, { shellName: 'Shell 2', command: 'sudo make install', focus, cancel });
		expect(s.status).toBe('waiting-shell');
		expect(s.busy).toBe(true);
		expect(s.shellWait?.shellName).toBe('Shell 2');
		s.goToShell();
		s.cancelShellWait();
		expect(focus).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
		reportShellWait(s.id, null);
		expect(s.status).toBe('running');
		expect(s.shellWait).toBeNull();
		turn.release();
		await sending;
		expect(s.status).toBe('idle');
	});

	it('ignores another session’s shell wait', async () => {
		const a = await newSession('/proj');
		const b = await newSession('/proj');
		const turn = held();
		mocks.runAgentLoop.mockImplementationOnce(turn.impl);
		const sending = a.send('go');
		await turn.running;
		reportShellWait(b.id, {
			shellName: 'Shell 1',
			command: 'x',
			focus: () => {},
			cancel: () => {}
		});
		expect(a.status).toBe('running');
		expect(b.status).toBe('idle');
		turn.release();
		await sending;
	});

	it('passes its own backend and effort, and saves changes to them', async () => {
		const s = await newSession('/proj');
		const backend = { baseUrl: 'http://remote', modelId: 'm' };
		await s.setBackend(backend);
		await s.setEffort('low');
		expect(db.rows.get(s.id)!.backend).toBe(JSON.stringify(backend));
		expect(db.rows.get(s.id)!.reasoning_effort).toBe('low');
		await s.send('hi');
		const o = mocks.runAgentLoop.mock.calls[0][0] as AgentLoopOptions;
		expect(o.backend).toEqual(backend);
		expect(o.reasoningEffort).toBe('low');
		expect(o.codeSessionId).toBe(s.id);
		await s.setBackend(null);
		expect(db.rows.get(s.id)!.backend).toBeNull();
	});

	it('renames', async () => {
		const s = await newSession('/proj');
		await s.rename('  Lint fixes ');
		expect(s.title).toBe('Lint fixes');
		expect(db.rows.get(s.id)!.title).toBe('Lint fixes');
	});
});

describe('background watch completions', () => {
	it('start a turn when the session is idle', async () => {
		const s = await newSession('/proj');
		mocks.completedWatches = [{ id: 'watch-1' }];
		mocks.watchHandlers.get(s.id)!();
		await vi.waitFor(() => expect(mocks.runAgentLoop).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(s.status).toBe('idle'));
		expect(mocks.consumeWatches).toHaveBeenCalledWith(['watch-1']);
		expect(String(s.messages[0].content)).toContain('has finished');
	});

	it('wait for a running turn to end', async () => {
		const s = await newSession('/proj');
		const turn = held();
		mocks.runAgentLoop.mockImplementationOnce(turn.impl);
		const sending = s.send('build it');
		await turn.running;
		mocks.completedWatches = [{ id: 'watch-1' }];
		mocks.watchHandlers.get(s.id)!();
		await Promise.resolve();
		expect(mocks.consumeWatches).not.toHaveBeenCalled();
		turn.release();
		await sending;
		await vi.waitFor(() => expect(mocks.runAgentLoop).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(s.status).toBe('idle'));
		expect(s.messages.filter((m) => m.role === 'user')).toHaveLength(2);
	});

	it('do nothing when none has finished', async () => {
		const s = await newSession('/proj');
		mocks.watchHandlers.get(s.id)!();
		await Promise.resolve();
		expect(mocks.runAgentLoop).not.toHaveBeenCalled();
	});
});

describe('closing a session', () => {
	it('stops its background processes and forgets its approval', async () => {
		const s = await newSession('/proj');
		approveSession(codeApprovalKey(s.id));
		await closeSession(s.id);
		expect(mocks.invoke).toHaveBeenCalledWith('code_bg_stop_owner', { owner: s.id });
		expect(mocks.clearCodeWatches).toHaveBeenCalledWith(s.id);
		expect(isSessionApproved(codeApprovalKey(s.id))).toBe(false);
		expect(mocks.watchHandlers.has(s.id)).toBe(false);
		expect(getOpenSessions()).toEqual([]);
		expect(getActiveSession()).toBeNull();
	});

	it('saves a turn it stops', async () => {
		const s = await newSession('/proj');
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			await new Promise<void>((resolve) =>
				o.signal!.addEventListener('abort', () => resolve(), { once: true })
			);
			throw new DOMException('Aborted', 'AbortError');
		});
		void s.send('long job');
		await vi.waitFor(() => expect(mocks.runAgentLoop).toHaveBeenCalled());
		await closeSession(s.id);
		expect(storedThread(s.id)?.messages).toEqual([{ role: 'user', content: 'long job' }]);
	});
});

describe('a streamed tool round', () => {
	it('shows calls as they are written, until each starts or the turn ends', async () => {
		const s = await newSession('/proj');
		const seen: { pending: string[]; round: string }[] = [];
		const look = () =>
			seen.push({
				pending: s.pendingToolCalls.map((c) => `${c.index}:${c.name}:${c.argsSoFar}`),
				round: s.roundText
			});
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			expect(o.streamToolRounds).toBe(true);
			o.onToolRoundStart!();
			o.onStreamChunk(
				{ delta: { reasoning_content: 'Write it.' }, finish_reason: null },
				{
					provisional: true
				}
			);
			o.onToolCallDelta!(0, { id: 'w', name: 'fs_write_text', argsSoFar: '{"path":"a' });
			o.onToolCallDelta!(1, { id: 'r', name: 'run_command', argsSoFar: '' });
			o.onToolCallDelta!(0, { id: 'w', name: 'fs_write_text', argsSoFar: '{"path":"a.ts"}' });
			look();
			o.onReasoning!('Write it.');
			const write = { id: 'w', name: 'fs_write_text', arguments: { path: 'a.ts' } };
			o.onToolStart(write);
			look();
			o.messages.push(
				{
					role: 'assistant',
					content: '',
					tool_calls: [
						{ id: 'w', type: 'function', function: { name: 'fs_write_text', arguments: '{}' } }
					]
				},
				{ role: 'tool', tool_call_id: 'w', content: 'ok' }
			);
			o.onToolEnd(write, 'ok');
			// The next round starts; the call it never ran is stale.
			o.onToolRoundStart!();
			look();
			o.onStreamChunk({ delta: { content: 'Done' }, finish_reason: null }, { provisional: true });
			look();
			o.onStreamChunk(chunk('Done'));
			look();
			o.onComplete();
		});

		await s.send('write a.ts');

		expect(seen).toEqual([
			{
				pending: ['0:fs_write_text:{"path":"a.ts"}', '1:run_command:'],
				round: '<think>Write it.'
			},
			{ pending: ['1:run_command:'], round: '' },
			{ pending: [], round: '' },
			{ pending: [], round: 'Done' },
			{ pending: [], round: '' }
		]);
		expect(s.pendingToolCalls).toEqual([]);
		expect(s.roundText).toBe('');
		// The round's reasoning sits on the step it led to; the answer is said once.
		const answer = s.messages.at(-1)!;
		expect(answer).toEqual({ role: 'assistant', content: 'Done' });
		expect(s.messageSteps[s.messages.length - 1][0].reasoning).toBe('Write it.');
	});

	it('saves what the model said with its calls, on the calls and on their step', async () => {
		const s = await newSession('/proj');
		const said = 'The import is wrong. Fixing it.';
		const edit = { id: 'e', name: 'fs_edit_text', arguments: { path: 'a.ts' } };
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			o.onToolRoundStart!();
			o.onStreamChunk({ delta: { content: said }, finish_reason: null }, { provisional: true });
			o.messages.push({
				role: 'assistant',
				content: said,
				tool_calls: [
					{ id: 'e', type: 'function', function: { name: 'fs_edit_text', arguments: '{}' } }
				]
			});
			o.onToolStart(edit);
			o.messages.push({ role: 'tool', tool_call_id: 'e', content: 'ok' });
			o.onToolEnd(edit, 'ok');
			o.onToolRoundStart!();
			o.onStreamChunk(chunk('Fixed.'));
			o.onComplete();
		});

		await s.send('fix the import');

		const saved = storedThread(s.id)!;
		expect(saved.messages.map((m) => [m.role, m.content])).toEqual([
			['user', 'fix the import'],
			['assistant', said],
			['tool', 'ok'],
			['assistant', 'Fixed.']
		]);
		const steps = saved.messageSteps[saved.messages.length - 1];
		expect(steps.map((st) => st.lead)).toEqual([said]);
	});

	it('shows a call written as text as a pending row, not as text', async () => {
		const s = await newSession('/proj');
		const seen: { pending: string[]; round: string }[] = [];
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			o.onToolRoundStart!();
			for (const part of [
				'Running it.\n<tool',
				'_call>\n{"name": "run_command", ',
				'"arguments": {"command": "python main.py"}}\n</tool_call>'
			]) {
				o.onStreamChunk({ delta: { content: part }, finish_reason: null }, { provisional: true });
				seen.push({
					pending: s.pendingToolCalls.map((c) => `${c.name}:${c.argsSoFar}`),
					round: s.roundText
				});
			}
			o.onComplete();
		});

		await s.send('run it');

		expect(seen).toEqual([
			{ pending: [], round: 'Running it.\n' },
			// The name is whole: a row, before the arguments arrive.
			{ pending: ['run_command:'], round: 'Running it.\n' },
			{
				pending: ['run_command:{"command": "python main.py"}}\n'],
				round: 'Running it.\n'
			}
		]);
	});

	it('clears a call being written when the turn is stopped', async () => {
		const s = await newSession('/proj');
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			o.onToolRoundStart!();
			o.onToolCallDelta!(0, { id: 'w', name: 'fs_write_text', argsSoFar: '{' });
			await new Promise<void>((resolve) =>
				o.signal!.addEventListener('abort', () => resolve(), { once: true })
			);
			throw new DOMException('Aborted', 'AbortError');
		});
		const sending = s.send('go');
		await vi.waitFor(() => expect(s.pendingToolCalls).toHaveLength(1));
		s.stop();
		await sending;
		expect(s.pendingToolCalls).toEqual([]);
		expect(s.roundText).toBe('');
	});
});

describe('one window per session', () => {
	it('claims a session it opens and releases it on close', async () => {
		const s = await newSession('/proj');
		expect(db.owners.get(s.id)).toBe('main');
		await closeSession(s.id);
		expect(db.owners.has(s.id)).toBe(false);
		await openSession(s.id);
		expect(db.owners.get(s.id)).toBe('main');
	});

	it('brings forward the window that has a session instead of opening it', async () => {
		const s = await newSession('/proj');
		await closeSession(s.id);
		db.owners.set(s.id, `code-${s.id}`);
		db.alive.add(`code-${s.id}`);
		expect(await openSession(s.id)).toBeNull();
		expect(getOpenSessions()).toHaveLength(0);
		expect(mocks.raised).toEqual([`code-${s.id}`]);
	});

	it('treats a claim whose window is gone as free', async () => {
		const s = await newSession('/proj');
		await closeSession(s.id);
		db.owners.set(s.id, `code-${s.id}`); // never alive: the window closed
		const again = await openSession(s.id);
		expect(again?.id).toBe(s.id);
		expect(db.owners.get(s.id)).toBe('main');
		expect(mocks.raised).toEqual([]);
	});

	it('hands a session off without stopping its background processes', async () => {
		const s = await newSession('/proj');
		const watch = {
			id: 'watch-1',
			source: 'code_bg',
			owner: s.id,
			processId: 'bg-1',
			command: 'npm run dev',
			logPath: '/l',
			startedAtMs: 0
		};
		mocks.takeCodeWatches.mockReturnValueOnce([watch]);
		expect(await handOffSession(s.id)).toBe(true);
		expect(getOpenSessions()).toHaveLength(0);
		expect(mocks.invoke).not.toHaveBeenCalledWith('code_bg_stop_owner', expect.anything());
		expect(db.owners.has(s.id)).toBe(false);
		expect(JSON.parse(db.handoffs.get(s.id)!)).toEqual({ watches: [watch] });

		// Whichever window opens it next takes the watches, and the
		// completion handler is that window's.
		mocks.watchHandlers.clear();
		const again = await openSession(s.id);
		expect(mocks.adoptCodeWatches).toHaveBeenCalledWith([watch]);
		expect(db.handoffs.has(s.id)).toBe(false);
		expect(mocks.watchHandlers.has(again!.id)).toBe(true);
	});

	it('delivers a watch that finished during the move once the session is open again', async () => {
		const s = await newSession('/proj');
		const done = {
			id: 'watch-2',
			source: 'code_bg',
			owner: s.id,
			processId: 'bg-2',
			command: 'make',
			logPath: '/l',
			startedAtMs: 0,
			exitCode: 0
		};
		mocks.takeCodeWatches.mockReturnValueOnce([done]);
		await handOffSession(s.id);
		const again = (await openSession(s.id))!;
		await vi.waitFor(() => expect(mocks.runAgentLoop).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(again.status).toBe('idle'));
		expect(again.messages[0]).toEqual({
			role: 'user',
			content: 'A background command you started with watch has finished.'
		});
	});

	it('will not hand off a session while a turn runs', async () => {
		const s = await newSession('/proj');
		const turn = held();
		mocks.runAgentLoop.mockImplementationOnce(turn.impl);
		const sending = s.send('go');
		await turn.running;
		expect(await handOffSession(s.id)).toBe(false);
		expect(getOpenSessions()).toContain(s);
		expect(db.owners.get(s.id)).toBe('main');
		turn.release();
		await sending;
	});

	it('refuses to delete a session another window has open', async () => {
		const s = await newSession('/proj');
		await closeSession(s.id);
		db.owners.set(s.id, `code-${s.id}`);
		db.alive.add(`code-${s.id}`);
		expect(await deleteSession(s.id)).toBe(false);
		expect(db.rows.has(s.id)).toBe(true);
		db.alive.delete(`code-${s.id}`);
		expect(await deleteSession(s.id)).toEqual({ worktree: null });
		expect(db.rows.has(s.id)).toBe(false);
		expect(db.owners.has(s.id)).toBe(false);
	});
});

describe('fork from a message', () => {
	async function twoTurns() {
		const s = await newSession('/proj');
		mocks.runAgentLoop.mockImplementationOnce(answers('first answer'));
		await s.send('first question');
		mocks.runAgentLoop.mockImplementationOnce(answers('second answer'));
		await s.send('second question');
		// user, assistant, user, assistant
		return s;
	}

	it('keeps everything up to and including a forked answer', async () => {
		const s = await twoTurns();
		const fork = (await forkAndOpen(s.id, 1))!;
		expect(fork.id).not.toBe(s.id);
		expect(fork.messages.map((m) => m.content)).toEqual(['first question', 'first answer']);
		expect(fork.prefill).toEqual({ text: '', images: [] });
		expect(getActiveSession()).toBe(fork);
		expect(db.rows.get(fork.id)!.forked_from).toBe(s.id);
		// The source is untouched.
		expect(s.messages).toHaveLength(4);
	});

	it('keeps what came before a forked user message, and hands its text to the input', async () => {
		const s = await twoTurns();
		const fork = (await forkAndOpen(s.id, 2))!;
		expect(fork.messages.map((m) => m.content)).toEqual(['first question', 'first answer']);
		expect(fork.takePrefill()).toEqual({ text: 'second question', images: [] });
		expect(fork.prefill).toBeNull();
	});

	it('forks the first and the last message', async () => {
		const s = await twoTurns();
		const first = (await forkAndOpen(s.id, 0))!;
		expect(first.messages).toEqual([]);
		expect(first.prefill?.text).toBe('first question');
		const last = (await forkAndOpen(s.id, 3))!;
		expect(last.messages).toHaveLength(4);
	});

	it('does not copy background processes or watches', async () => {
		const s = await twoTurns();
		const fork = (await forkAndOpen(s.id, 1))!;
		expect(mocks.takeCodeWatches).not.toHaveBeenCalled();
		expect(mocks.invoke).toHaveBeenCalledWith('code_bg_status', { owner: fork.id });
		expect(mocks.invoke).not.toHaveBeenCalledWith('code_bg_start', expect.anything());
	});

	it('will not fork while a turn runs, or from a tool message', async () => {
		const s = await twoTurns();
		const turn = held();
		mocks.runAgentLoop.mockImplementationOnce(turn.impl);
		const sending = s.send('third');
		await turn.running;
		await expect(forkSession(s.id, 1)).rejects.toThrow(/turn/);
		turn.release();
		await sending;
		s.messages = [...s.messages, { role: 'tool', tool_call_id: 'x', content: 'r' }];
		await expect(forkSession(s.id, s.messages.length - 1)).rejects.toThrow();
	});
});

describe('sharing a folder', () => {
	async function answered() {
		const s = await newSession('/proj');
		mocks.runAgentLoop.mockImplementationOnce(answers('first answer'));
		await s.send('first question');
		return s;
	}

	const systemText = (o: AgentLoopOptions) => String(o.messages[0].content);

	it('a read-only fork runs without the write tools and says so', async () => {
		const s = await answered();
		const fork = (await forkAndOpen(s.id, 1, 'readOnly'))!;
		expect(fork.readOnly).toBe(true);
		expect(fork.root).toBe('/proj');
		await fork.send('look around');
		const o = mocks.runAgentLoop.mock.calls.at(-1)![0] as AgentLoopOptions;
		expect(o.codeReadOnly).toBe(true);
		expect(systemText(o)).toContain('READ-ONLY');
		// The source can still write.
		await s.send('again');
		expect((mocks.runAgentLoop.mock.calls.at(-1)![0] as AgentLoopOptions).codeReadOnly).toBe(false);
	});

	it('a worktree fork is rooted in its worktree and told to set it up', async () => {
		const s = await answered();
		db.folders.git.set('/wt/s2', {
			repo_root: '/wt/s2',
			branch: 'first-fork',
			head: 'abc1234',
			changed: 0,
			untracked: 0,
			linked_worktree: true,
			default_branch: 'main'
		});
		const fork = (await forkAndOpen(s.id, 1, 'worktree'))!;
		expect(fork.readOnly).toBe(false);
		expect(fork.root).toBe('/wt/s2');
		expect(fork.worktree).toBe('/wt/s2');
		await fork.refreshGit();
		expect(fork.git?.branch).toBe('first-fork');
		await fork.send('build it');
		const o = mocks.runAgentLoop.mock.calls.at(-1)![0] as AgentLoopOptions;
		expect(o.workingDir).toBe('/wt/s2');
		expect(systemText(o)).toContain('fresh git worktree on branch first-fork');
	});

	it('tells the model when the branch changed between its turns', async () => {
		const s = await answered();
		const at = (branch: string) =>
			db.folders.git.set('/proj', {
				repo_root: '/proj',
				branch,
				head: 'abc1234',
				changed: 0,
				untracked: 0,
				linked_worktree: false,
				default_branch: 'main'
			});
		const opening = () =>
			String(
				(mocks.runAgentLoop.mock.calls.at(-1)![0] as AgentLoopOptions).messages.at(-1)!.content
			);
		// The answered turn ran outside git; the repo appearing is news.
		at('bob');
		await s.send('first');
		expect(opening()).toContain("The checked-out git branch is now 'bob'.");
		await s.send('second');
		expect(opening()).toBe('second');
		// Switched from the branch menu between turns.
		at('sally');
		await s.send('which branch?');
		expect(opening()).toContain("now 'sally' (it was 'bob')");
		expect(s.fileNotes.at(-1)?.text).toContain("now 'sally'");
		await s.send('again');
		expect(opening()).toBe('again');
	});

	it('tells the model at the start of a turn what another session changed, once', async () => {
		const s = await answered();
		db.folders.notices = [
			{ session_id: 'other', title: 'Other', files: ['/proj/src/a.ts', '/proj/b.ts'], at: 5 }
		];
		await s.send('carry on');
		const o = mocks.runAgentLoop.mock.calls.at(-1)![0] as AgentLoopOptions;
		const opening = o.messages.at(-1)!;
		expect(String(opening.content)).toMatch(
			/^\[Note from Haruspex\] Since your last turn, session 'Other' changed: src\/a\.ts, b\.ts/
		);
		expect(String(opening.content)).toContain('carry on');
		// Shown above the message it came with, and not saved into it.
		expect(s.fileNotes).toEqual([{ text: expect.stringContaining('src/a.ts'), at: 2 }]);
		expect(storedThread(s.id)?.messages[2].content).toBe('carry on');
		expect(mocks.invoke).toHaveBeenCalledWith('code_notices_take', {
			folder: '/proj',
			sessionId: s.id,
			since: 1
		});
		// Delivered: the next turn opens without it, from the time Rust gave.
		await s.send('more');
		const next = mocks.runAgentLoop.mock.calls.at(-1)![0] as AgentLoopOptions;
		expect(String(next.messages.at(-1)!.content)).toBe('more');
		expect(mocks.invoke).toHaveBeenCalledWith(
			'code_notices_take',
			expect.objectContaining({ since: 99 })
		);
	});

	it('takes the folder on its first write, records what it changed, and gives it back', async () => {
		const s = await newSession('/proj');
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			expect(await o.codeWriteGuard!.acquire()).toBeNull();
			expect(await o.codeWriteGuard!.acquire()).toBeNull();
			o.codeWriteGuard!.changed(['src/a.ts', '/proj/b.ts']);
			o.onStreamChunk(chunk('done'));
			o.onComplete();
		});
		await s.send('edit');
		const leaseCalls = mocks.invoke.mock.calls.filter((c) => c[0] === 'code_lease_take');
		expect(leaseCalls).toHaveLength(1);
		expect(leaseCalls[0][1]).toEqual({ folder: '/proj', sessionId: s.id, title: '' });
		expect(mocks.invoke).toHaveBeenCalledWith('code_notice_record', {
			folder: '/proj',
			sessionId: s.id,
			title: '',
			files: ['/proj/src/a.ts', '/proj/b.ts']
		});
		expect(mocks.invoke).toHaveBeenCalledWith('code_lease_release', { sessionId: s.id });
	});

	it('refuses a write while another session holds the folder', async () => {
		const s = await newSession('/proj');
		db.folders.holder = 'Fix login';
		let refusal: string | null = null;
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			refusal = await o.codeWriteGuard!.acquire();
			o.onComplete();
		});
		await s.send('edit');
		expect(refusal).toBe(
			'Another session (Fix login) is editing this folder right now; wait for it to finish, or work in a worktree.'
		);
		// Never held, so nothing to give back at the end of the turn.
		expect(mocks.invoke).not.toHaveBeenCalledWith('code_notice_record', expect.anything());
	});

	it('deletes a worktree session with its worktree when asked', async () => {
		const s = await answered();
		const fork = (await forkAndOpen(s.id, 1, 'worktree'))!;
		const done = await deleteSession(fork.id, { removeWorktree: fork.worktree });
		expect(done).toEqual({ worktree: { kind: 'removed' } });
		expect(mocks.invoke).toHaveBeenCalledWith('code_git_worktree_remove', { path: '/wt/s2' });
		expect(db.rows.has(fork.id)).toBe(false);
	});

	it('keeps the worktree when the removal fails', async () => {
		const s = await answered();
		const fork = (await forkAndOpen(s.id, 1, 'worktree'))!;
		mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === 'code_git_worktree_remove') throw 'git exploded';
			return db.handle(cmd, args);
		});
		const done = await deleteSession(fork.id, { removeWorktree: '/wt/s2' });
		expect(done).toEqual({ worktree: { kind: 'kept', reason: 'git exploded' } });
	});
});
