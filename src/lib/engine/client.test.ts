import { describe, it, expect, vi, afterEach } from 'vitest';

import { EngineClient, LIST_REFRESH_MS } from './client.svelte.ts';
import type { StreamEvent, Transport } from './transport.ts';
import type { ChatState, Prompt, SessionState } from './types.ts';

const state = (over: Partial<SessionState> = {}): SessionState => ({
	id: 's1',
	root: '/p',
	wslDistro: null,
	status: 'idle',
	busy: false,
	streamingContent: '',
	roundText: '',
	searchSteps: [],
	messages: [],
	messageSteps: {},
	messageStats: {},
	messageStops: {},
	title: '',
	usage: null,
	lastError: null,
	saveError: null,
	folderMissing: false,
	steering: [],
	background: [],
	shellWait: null,
	compaction: null,
	compacting: false,
	...over
});

/** Another Haruspex: answers ops from a table and lets the test push events. */
function fake(answers: Record<string, unknown> = {}) {
	const ops: { type: string; id?: string }[] = [];
	let push: (e: StreamEvent) => void = () => {};
	const transport: Transport = {
		op: (async (o: { type: string }) => {
			ops.push(o);
			return answers[o.type] ?? null;
		}) as Transport['op'],
		events: (onEvent, onConnection) => {
			push = onEvent;
			onConnection('open');
			return () => {};
		},
		upload: async () => ({ hash: '0'.repeat(64) })
	};
	const client = new EngineClient(transport);
	client.start();
	return {
		client,
		ops,
		push: (e: StreamEvent) => push(e),
		count: (type: string) => ops.filter((o) => o.type === type).length
	};
}

afterEach(() => vi.useRealTimers());

describe('EngineClient', () => {
	it('rebuilds a followed session from its snapshot, then its patches', async () => {
		const f = fake({ 'session.get': state({ title: 'Before' }) });
		await f.client.follow('s1');
		expect(f.ops.map((o) => o.type)).toEqual(['session.open', 'session.get', 'session.resync']);
		expect(f.client.mirrors.s1.state?.title).toBe('Before');

		f.push({ seq: 4, sessionId: 's1', type: 'status', status: 'running', busy: true });
		expect(f.client.mirrors.s1.state?.status).toBe('idle');
		f.push({ seq: 5, sessionId: 's1', type: 'snapshot', state: state({ title: 'After' }) });
		f.push({ seq: 6, sessionId: 's1', type: 'live', streamingContent: 'Hi', roundText: '' });
		expect(f.client.mirrors.s1.state?.title).toBe('After');
		expect(f.client.mirrors.s1.state?.streamingContent).toBe('Hi');
	});

	it('asks for a resync on a gap in the sequence', async () => {
		vi.useFakeTimers();
		const f = fake({ 'session.get': state() });
		await f.client.follow('s1');
		f.push({ seq: 1, sessionId: 's1', type: 'snapshot', state: state() });
		await vi.advanceTimersByTimeAsync(4000);
		const before = f.count('session.resync');
		f.push({ seq: 3, sessionId: 's1', type: 'live', streamingContent: 'x', roundText: '' });
		expect(f.count('session.resync')).toBe(before + 1);
	});

	it('on ready, reads the lists again and resyncs everything it follows', async () => {
		const chat = { id: 'c1', open: true, busy: false } as ChatState;
		vi.useFakeTimers();
		const f = fake({ 'session.get': state(), 'chat.get': chat });
		await f.client.follow('s1');
		await f.client.follow('s2');
		await f.client.followChat('c1');
		const ready = vi.fn();
		f.client.onReady(ready);
		// Past the resyncs the follows asked for.
		await vi.advanceTimersByTimeAsync(4000);
		f.ops.length = 0;

		f.push({ type: 'ready' });
		await vi.advanceTimersByTimeAsync(0);
		const types = f.ops.map((o) => o.type);
		for (const t of ['sessions.list', 'chats.list', 'prompts.list', 'chat.get', 'chat.resync'])
			expect(types).toContain(t);
		expect(f.ops.filter((o) => o.type === 'session.resync').map((o) => o.id)).toEqual(['s1', 's2']);
		expect(ready).toHaveBeenCalledOnce();
	});

	it('reads the list once for a burst of changes', async () => {
		vi.useFakeTimers();
		const f = fake();
		for (let seq = 1; seq <= 5; seq++)
			f.push({ seq, sessionId: `s${seq}`, type: 'status', status: 'running', busy: true });
		await vi.advanceTimersByTimeAsync(LIST_REFRESH_MS + 50);
		expect(f.count('sessions.list')).toBe(1);
	});

	it('stops applying events to a session it no longer follows', async () => {
		const f = fake({ 'session.get': state() });
		await f.client.follow('s1');
		f.client.unfollow('s1');
		f.push({ seq: 1, sessionId: 's1', type: 'snapshot', state: state() });
		expect(f.client.mirrors.s1).toBeUndefined();
	});

	it('says when a prompt arrives and when it goes', () => {
		const f = fake();
		const arrived = vi.fn();
		const gone = vi.fn();
		f.client.onPrompt(arrived);
		f.client.onPromptGone(gone);
		const prompt = { promptId: 'main:1', sessionId: 's1' } as Prompt;
		f.push({ seq: 1, sessionId: 's1', type: 'prompt', prompt });
		expect(arrived).toHaveBeenCalledWith(prompt);
		expect(Object.keys(f.client.prompts)).toEqual(['main:1']);
		f.push({ seq: 2, sessionId: 's1', type: 'prompt-cleared', promptId: 'main:1' });
		expect(gone).toHaveBeenCalledWith('main:1');
		expect(f.client.prompts).toEqual({});
	});
});
