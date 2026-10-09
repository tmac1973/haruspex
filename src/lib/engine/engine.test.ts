import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentLoopOptions } from '#lib/agent/loop.ts';
import type { ChatMessage } from '#lib/api.ts';

// A small in-memory `code_sessions` table and claim map: enough for a
// session to be created, run a turn and save it, as `code.test.ts` does.
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
						backend: null,
						reasoning_effort: null,
						thread: emptyThread,
						forked_from: null,
						forked_at: null,
						created_at: n,
						updated_at: n
					};
					rows.set(row.id, row);
					return { ...row };
				}
				case 'code_session_save': {
					const row = rows.get(args.id as string)!;
					row.thread = args.thread;
					return undefined;
				}
				case 'code_session_list':
					return [...rows.values()].map((r) => ({
						id: r.id,
						title: r.title,
						root: r.root,
						updated_at: r.updated_at,
						forked_from: null,
						read_only: false,
						worktree: null
					}));
				case 'code_session_claim':
					return { owner: null, handoff: null };
				case 'code_bg_status':
					return [];
				case 'code_folder_exists':
					return true;
				case 'code_notices_take':
					return { notices: [], now: 1 };
				default:
					return undefined;
			}
		}
	};
});

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	runAgentLoop: vi.fn(),
	withInferenceSlot: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/agent/loop.ts', () => ({ runAgentLoop: mocks.runAgentLoop }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: mocks.withInferenceSlot
}));
vi.mock('#lib/code/sessionTitle.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/code/sessionTitle.ts')>()),
	nameSession: async () => 'Fix the average'
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
vi.mock('#lib/debug-log.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debug-log.ts')>()),
	logDebug: () => {}
}));

import { flushSync } from 'svelte';
import { closeSession, getOpenSessions, newSession } from '#lib/stores/code.svelte.ts';
import { askCommandApproval } from '#lib/stores/codeCommandApproval.svelte.ts';
import { askUserQuestion } from '#lib/stores/userQuestion.svelte.ts';
import { dispatch, setResync } from './dispatch.ts';
import { emptyMirror, reduce, type Mirror } from './reduce.ts';
import { answerPrompt, currentPrompts, watchPrompts } from './prompts.svelte.ts';
import { sessionState } from './state.ts';
import type { PromptEvent, SessionEvent } from './types.ts';
import { LIVE_MS, watchOpenSessions, watchSession } from './watch.svelte.ts';

function chunk(content: string) {
	return { delta: { content } } as unknown as Parameters<AgentLoopOptions['onStreamChunk']>[0];
}

/** Stop points a scripted turn waits at, so a test can look mid-turn. */
function gates() {
	let arrived!: () => void;
	let arrival = new Promise<void>((r) => (arrived = r));
	let resume!: () => void;
	return {
		/** In the turn: say we are here, then wait for `go`. */
		async pause() {
			const wait = new Promise<void>((r) => (resume = r));
			arrived();
			await wait;
		},
		/** In the test: wait until the turn pauses. */
		async reached() {
			await arrival;
			arrival = new Promise<void>((r) => (arrived = r));
		},
		go: () => resume()
	};
}

/** Let effects run and the coalesced live text go out. */
async function settle() {
	flushSync();
	await new Promise((r) => setTimeout(r, LIVE_MS * 2));
	flushSync();
}

function mirrorOf(events: SessionEvent[]): Mirror {
	return events.reduce(reduce, emptyMirror());
}

beforeEach(async () => {
	for (const s of [...getOpenSessions()]) await closeSession(s.id);
	db.reset();
	mocks.invoke
		.mockReset()
		.mockImplementation(async (cmd: string, args?: Record<string, unknown>) =>
			db.handle(cmd, args)
		);
	mocks.withInferenceSlot
		.mockReset()
		.mockImplementation(async (o: { onAdmitted?: () => void }, fn: () => Promise<unknown>) => {
			o.onAdmitted?.();
			return fn();
		});
});

describe('the events a session sends', () => {
	let events: SessionEvent[];
	let stop: () => void;

	beforeEach(() => {
		events = [];
	});
	afterEach(() => stop?.());

	/** The events, replayed, give exactly what the store holds. */
	async function agree(s: Awaited<ReturnType<typeof newSession>>) {
		await settle();
		const m = mirrorOf(events);
		expect(m.resync).toBe(false);
		expect(m.state).toEqual(sessionState(s));
	}

	it('rebuild the session mid-stream, mid-tool, with steering, and once saved', async () => {
		const s = await newSession('/proj');
		stop = watchSession(s, (e) => events.push(e)).stop;
		const g = gates();
		const edit = {
			id: 'e1',
			name: 'fs_edit_text',
			arguments: { path: 'stats.js', old_str: 'i <= n', new_str: 'i < n' }
		};
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			o.onStreamChunk(chunk('Looking at the loop'));
			await g.pause();
			o.onToolStart(edit);
			o.onToolProgress?.(edit, 'editing');
			await g.pause();
			const call: ChatMessage = {
				role: 'assistant',
				content: '',
				tool_calls: [
					{ id: 'e1', type: 'function', function: { name: 'fs_edit_text', arguments: '{}' } }
				]
			};
			o.messages.push(call, { role: 'tool', tool_call_id: 'e1', content: 'Edited stats.js' });
			o.onToolEnd(edit, 'Edited stats.js');
			o.takeSteering?.();
			o.onStreamChunk(chunk('Fixed the off-by-one.'));
			o.onComplete();
		});

		const sending = s.send('fix the average');
		await g.reached();
		await agree(s);
		expect(s.streamingContent).toContain('Looking');

		await s.send('also add a test');
		expect(s.steering).toEqual(['also add a test']);
		g.go();
		await g.reached();
		await agree(s);
		expect(s.searchSteps).toHaveLength(1);

		g.go();
		await sending;
		await agree(s);
		expect(s.status).toBe('idle');
		expect(s.messages.at(-1)?.content).toContain('Fixed the off-by-one.');
	});

	it('rebuild a stopped turn', async () => {
		const s = await newSession('/proj');
		stop = watchSession(s, (e) => events.push(e)).stop;
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			o.onStreamChunk(chunk('Starting'));
			await new Promise<void>((resolve) =>
				o.signal!.addEventListener('abort', () => resolve(), { once: true })
			);
			throw new DOMException('Aborted', 'AbortError');
		});
		const sending = s.send('refactor it');
		await vi.waitFor(() => expect(mocks.runAgentLoop).toHaveBeenCalled());
		s.stop();
		await sending;
		await agree(s);
		expect(s.lastError).toBe('Stopped.');
	});

	it('rebuild a turn that failed', async () => {
		const s = await newSession('/proj');
		stop = watchSession(s, (e) => events.push(e)).stop;
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			o.onError(new Error('the server went away'));
		});
		await s.send('hello');
		await agree(s);
		expect(s.lastError).toContain('the server went away');
	});

	it('number each session from one, starting with a snapshot', async () => {
		const s = await newSession('/proj');
		stop = watchSession(s, (e) => events.push(e)).stop;
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			o.onStreamChunk(chunk('ok'));
			o.onComplete();
		});
		await s.send('hi');
		await settle();
		expect(events[0].type).toBe('snapshot');
		expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
	});

	it('say a closed session is closed', async () => {
		events = [];
		const watch = watchOpenSessions((e) => events.push(e as SessionEvent));
		stop = watch.stop;
		const s = await newSession('/proj');
		await settle();
		expect(events.some((e) => e.sessionId === s.id && e.type === 'snapshot')).toBe(true);
		await closeSession(s.id);
		await settle();
		expect(events.at(-1)).toMatchObject({ sessionId: s.id, type: 'closed' });
		expect(mirrorOf(events.filter((e) => e.sessionId === s.id)).closed).toBe(true);
	});
});

describe('the mirror', () => {
	const snap = (seq: number) =>
		({
			seq,
			sessionId: 's',
			type: 'snapshot',
			state: { status: 'idle' }
		}) as unknown as SessionEvent;

	it('asks for a resync on a gap, and keeps what it had', () => {
		let m = reduce(emptyMirror(), snap(1));
		const before = m.state;
		m = reduce(m, { seq: 3, sessionId: 's', type: 'status', status: 'running', busy: true });
		expect(m.resync).toBe(true);
		expect(m.state).toBe(before);
	});

	it('asks for a resync on an event before any snapshot', () => {
		const m = reduce(emptyMirror(), {
			seq: 4,
			sessionId: 's',
			type: 'live',
			streamingContent: 'x',
			roundText: ''
		});
		expect(m).toMatchObject({ state: null, resync: true });
	});

	it('takes a snapshot whatever came before', () => {
		let m = reduce(emptyMirror(), snap(1));
		m = reduce(m, { seq: 9, sessionId: 's', type: 'status', status: 'running', busy: true });
		m = reduce(m, snap(10));
		expect(m).toMatchObject({ resync: false, seq: 10 });
	});
});

describe('prompts', () => {
	it('carry the asking session, and answer only the one showing', async () => {
		const first = askCommandApproval({
			command: 'rm -rf a',
			reasons: [],
			requester: 'Code · A',
			sessionId: 's1'
		});
		const second = askCommandApproval({
			command: 'rm -rf b',
			reasons: [],
			requester: 'Code · B',
			sessionId: 's2'
		});
		const [p1] = currentPrompts('main');
		expect(p1).toMatchObject({ kind: 'command', sessionId: 's1', detail: { queued: 1 } });

		answerPrompt('main', p1.promptId, { kind: 'command', choice: 'deny' });
		expect(await first).toBe('deny');
		// A second screen answering the prompt it saw: that one is gone.
		expect(() => answerPrompt('main', p1.promptId, { kind: 'command', choice: 'deny' })).toThrow(
			'not showing'
		);
		const [p2] = currentPrompts('main');
		expect(p2).toMatchObject({ sessionId: 's2' });
		expect(p2.promptId).not.toBe(p1.promptId);
		answerPrompt('main', p2.promptId, { kind: 'command', choice: 'allow_once' });
		expect(await second).toBe('allow_once');
	});

	it('answers a question with the answer it was given', async () => {
		const asked = askUserQuestion({
			question: 'Which file?',
			options: [{ label: 'a.ts' }, { label: 'b.ts' }],
			sessionId: 's1'
		});
		const [p] = currentPrompts('main');
		expect(p).toMatchObject({ kind: 'question', sessionId: 's1', answerable: true });
		expect(() => answerPrompt('main', p.promptId, { kind: 'command', choice: 'deny' })).toThrow(
			'question prompt'
		);
		answerPrompt('main', p.promptId, {
			kind: 'question',
			answer: { kind: 'selected', labels: ['b.ts'] }
		});
		expect(await asked).toEqual({ kind: 'selected', labels: ['b.ts'] });
	});

	it('send an event as a prompt shows and as it goes', async () => {
		const events: PromptEvent[] = [];
		const stop = watchPrompts('main', (e) => events.push(e));
		const asked = askCommandApproval({ command: 'rm x', reasons: [], sessionId: 's1' });
		flushSync();
		const [p] = currentPrompts('main');
		answerPrompt('main', p.promptId, { kind: 'command', choice: 'deny' });
		await asked;
		flushSync();
		stop();
		expect(events.map((e) => e.type)).toEqual(['prompt', 'prompt-cleared']);
		expect(events[0]).toMatchObject({ sessionId: 's1', seq: 1 });
	});
});

describe('operations', () => {
	it('send to a session, or steer it while it runs', async () => {
		const s = await newSession('/proj');
		const g = gates();
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			await g.pause();
			o.takeSteering?.();
			o.onStreamChunk(chunk('done'));
			o.onComplete();
		});
		expect(await dispatch({ type: 'session.send', id: s.id, text: 'go' }, 'main')).toEqual({
			started: true
		});
		await g.reached();
		expect(await dispatch({ type: 'session.send', id: s.id, text: 'and this' }, 'main')).toEqual({
			steered: true
		});
		g.go();
		await vi.waitFor(() => expect(s.status).toBe('idle'));
	});

	it('refuse a session that is not open here', async () => {
		await expect(dispatch({ type: 'session.get', id: 'nope' }, 'main')).rejects.toThrow('not open');
	});

	it('list open sessions with their status, and saved ones without', async () => {
		const a = await newSession('/a');
		const b = await newSession('/b');
		await closeSession(b.id);
		const list = await dispatch({ type: 'sessions.list' }, 'main');
		expect(list).toEqual([
			{ id: a.id, title: '', root: '/a', status: 'idle', window: 'main' },
			{ id: b.id, title: '', root: '/b', status: null, window: null }
		]);
	});

	it('resync sends a fresh snapshot', async () => {
		const events: SessionEvent[] = [];
		const watch = watchOpenSessions((e) => events.push(e as SessionEvent));
		setResync(watch.resync);
		const s = await newSession('/proj');
		await settle();
		const before = events.length;
		await dispatch({ type: 'session.resync', id: s.id }, 'main');
		expect(events.slice(before)).toMatchObject([{ type: 'snapshot', sessionId: s.id }]);
		watch.stop();
	});
});
