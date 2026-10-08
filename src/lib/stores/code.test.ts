import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentLoopOptions } from '#lib/agent/loop.ts';
import type { ChatMessage } from '#lib/api.ts';

// The Tauri boundary is an in-memory `code_sessions` table, so a session can
// be saved, closed and loaded back by id as the app would.
const db = vi.hoisted(() => {
	const rows = new Map<string, Record<string, unknown>>();
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
		reset() {
			rows.clear();
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
					return undefined;
			}
		}
	};
});

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	runAgentLoop: vi.fn(),
	withInferenceSlot: vi.fn(),
	watchHandlers: new Map<string, () => void>(),
	completedWatches: [] as { id: string }[],
	consumeWatches: vi.fn(),
	clearCodeWatches: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/agent/loop.ts', () => ({ runAgentLoop: mocks.runAgentLoop }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: mocks.withInferenceSlot
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
	clearCodeWatches: mocks.clearCodeWatches
}));
vi.mock('#lib/debug-log.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debug-log.ts')>()),
	logDebug: () => {}
}));

import {
	closeSession,
	getActiveSession,
	getOpenSessions,
	newSession,
	openSession,
	titleFromMessage
} from '#lib/stores/code.svelte.ts';
import { decodeCodeSession } from '#lib/code/session.ts';
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
	mocks.completedWatches = [];
	mocks.consumeWatches.mockReset();
	mocks.clearCodeWatches.mockReset();
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
		const again = await openSession(s.id);
		expect(again).not.toBe(s);
		expect(again.messages).toEqual(s.messages);
		expect(again.messageSteps).toEqual(s.messageSteps);
		expect(again.title).toBe('where is x defined?');
	});

	it('opens a session with an empty thread as an empty session', async () => {
		const s = await newSession('/proj');
		await closeSession(s.id);
		const again = await openSession(s.id);
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

	it('names itself from the first message only', async () => {
		const s = await newSession('/proj');
		await s.send(`  fix   the\nbuild ${'x'.repeat(80)}`);
		expect(s.title).toBe(titleFromMessage(`fix the build ${'x'.repeat(80)}`));
		expect(s.title).toHaveLength(60);
		expect(db.rows.get(s.id)!.title).toBe(s.title);
		await s.send('something else');
		expect(s.title).toHaveLength(60);
		expect(s.title.startsWith('fix the build')).toBe(true);
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
