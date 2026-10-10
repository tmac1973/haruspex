import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { flushSync } from 'svelte';

import type { Prompt, SessionEvent, SessionState } from '#lib/engine/types.ts';
import { sseParser, type StreamEvent } from './api.ts';
import { WebStore, type Transport } from './store.svelte.ts';
import PromptCard from './components/PromptCard.svelte';
import Composer from './components/Composer.svelte';

const state = (over: Partial<SessionState> = {}): SessionState => ({
	id: 's1',
	root: '/p',
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
	...over
});

/** A desktop that answers ops from a table and lets the test push events. */
function fakeDesktop(answers: Record<string, unknown> = {}) {
	const ops: { type: string }[] = [];
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
		}
	};
	return { transport, ops, push: (e: StreamEvent) => push(e) };
}

describe('the event stream', () => {
	it('splits frames across chunks and joins multi-line data', () => {
		const got: string[] = [];
		const feed = sseParser((d) => got.push(d));
		feed('data: {"a":1}\n\nda');
		feed('ta: {"b":\ndata: 2}\n\n: keepalive\n\n');
		expect(got).toEqual(['{"a":1}', '{"b":\n2}']);
	});
});

describe('the web store', () => {
	it('shows a session at once, then follows it from its snapshot', async () => {
		const d = fakeDesktop({
			'sessions.list': [{ id: 's1', title: 'T', root: '/p', status: 'idle', window: 'main' }],
			'session.get': state({ title: 'T' })
		});
		const store = new WebStore(d.transport);
		store.start();
		await store.refreshList();
		await store.select('s1');
		expect(store.current?.title).toBe('T');
		expect(d.ops.map((o) => o.type)).toContain('session.resync');

		// Until the snapshot, events are ignored rather than guessed at.
		d.push({ seq: 7, sessionId: 's1', type: 'status', status: 'running', busy: true });
		expect(store.current?.status).toBe('idle');
		d.push({ seq: 8, sessionId: 's1', type: 'snapshot', state: state({ title: 'T' }) });
		d.push({ seq: 9, sessionId: 's1', type: 'status', status: 'running', busy: true });
		expect(store.current?.status).toBe('running');
		store.stop();
	});

	it('asks for a resync when it misses an event', async () => {
		const d = fakeDesktop({ 'session.get': state() });
		const store = new WebStore(d.transport);
		store.start();
		await store.select('s1');
		d.push({ seq: 1, sessionId: 's1', type: 'snapshot', state: state() });
		const before = d.ops.filter((o) => o.type === 'session.resync').length;
		vi.useFakeTimers();
		vi.advanceTimersByTime(4000);
		vi.useRealTimers();
		d.push({ seq: 3, sessionId: 's1', type: 'live', streamingContent: 'x', roundText: '' });
		expect(d.ops.filter((o) => o.type === 'session.resync').length).toBe(before + 1);
		expect(store.current?.streamingContent).toBe('');
		store.stop();
	});

	it('keeps a closed session on screen and says so', async () => {
		const d = fakeDesktop({ 'session.get': state() });
		const store = new WebStore(d.transport);
		store.start();
		await store.select('s1');
		d.push({ seq: 1, sessionId: 's1', type: 'snapshot', state: state({ title: 'Kept' }) });
		d.push({ seq: 2, sessionId: 's1', type: 'closed' } as SessionEvent);
		expect(store.mirrors.s1.closed).toBe(true);
		expect(store.current?.title).toBe('Kept');
		store.stop();
	});

	it('tracks prompts from their events', () => {
		const d = fakeDesktop();
		const store = new WebStore(d.transport);
		store.start();
		const prompt: Prompt = {
			promptId: 'main:1',
			kind: 'command',
			sessionId: 's1',
			answerable: true,
			requester: null,
			detail: { command: 'rm -rf x' }
		};
		d.push({ seq: 1, sessionId: 's1', type: 'prompt', prompt });
		expect(store.promptsFor('s1')).toHaveLength(1);
		expect(store.promptsFor('s2')).toHaveLength(0);
		d.push({ seq: 2, sessionId: 's1', type: 'prompt-cleared', promptId: 'main:1' });
		expect(store.promptsFor('s1')).toHaveLength(0);
		store.stop();
	});
});

describe('the prompt card', () => {
	it('answers a command with the prompt it shows', async () => {
		const onanswer = vi.fn();
		render(PromptCard, {
			prompt: {
				promptId: 'code-s1:4',
				kind: 'command',
				sessionId: 's1',
				answerable: true,
				requester: null,
				detail: { command: 'rm -rf build', reasons: ['destructive'], queued: 0 }
			},
			onanswer
		});
		expect(screen.getByText('rm -rf build')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
		expect(onanswer).toHaveBeenCalledWith('code-s1:4', { kind: 'command', choice: 'deny' });
	});

	it('answers a question with a picked option or the owner’s own words', async () => {
		const onanswer = vi.fn();
		render(PromptCard, {
			prompt: {
				promptId: 'main:2',
				kind: 'question',
				sessionId: 's1',
				answerable: true,
				requester: null,
				detail: { question: 'Which file?', options: [{ label: 'a.ts' }, { label: 'b.ts' }] }
			},
			onanswer
		});
		await fireEvent.click(screen.getByRole('button', { name: 'b.ts' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
		expect(onanswer).toHaveBeenLastCalledWith('main:2', {
			kind: 'question',
			answer: { kind: 'selected', labels: ['b.ts'] }
		});
	});

	it('says an MCP approval is answered at the computer', () => {
		render(PromptCard, {
			prompt: {
				promptId: 'main:3',
				kind: 'mcp',
				sessionId: null,
				answerable: false,
				requester: null,
				detail: {}
			},
			onanswer: vi.fn()
		});
		expect(screen.getByText(/Answer it on your computer/)).toBeTruthy();
		expect(screen.queryByRole('button')).toBeNull();
	});
});

describe('the composer', () => {
	it('sends on Enter and keeps the text if sending fails', async () => {
		let ok = false;
		const onsend = vi.fn(async () => ok);
		render(Composer, { busy: false, onsend, onstop: vi.fn() });
		const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
		await fireEvent.input(box, { target: { value: 'fix it' } });
		await fireEvent.keyDown(box, { key: 'Enter' });
		await vi.waitFor(() => expect(onsend).toHaveBeenCalledWith('fix it'));
		expect(box.value).toBe('fix it');
		ok = true;
		await fireEvent.keyDown(box, { key: 'Enter' });
		await vi.waitFor(() => expect(box.value).toBe(''));
	});

	it('offers Stop and queues while the agent works', () => {
		const onstop = vi.fn();
		render(Composer, { busy: true, onsend: vi.fn(), onstop });
		flushSync();
		expect(screen.getByRole('button', { name: 'Queue' })).toBeTruthy();
		screen.getByRole('button', { name: 'Stop' }).click();
		expect(onstop).toHaveBeenCalled();
	});
});
