import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { flushSync } from 'svelte';

import type { Prompt, SessionEvent, SessionState } from '#lib/engine/types.ts';
import { sseParser, type StreamEvent } from './api.ts';
import { WebStore, type Transport } from './store.svelte.ts';
import PromptCard from './components/PromptCard.svelte';
import Composer from './components/Composer.svelte';
import FileViewer from './components/FileViewer.svelte';
import Message from './components/Message.svelte';

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

describe('the file viewer', () => {
	it('opens a file through the store, or says why it could not', async () => {
		const d = fakeDesktop({
			'session.readFile': { path: 'src/a.ts', content: 'const a = 1;', truncated: false }
		});
		const store = new WebStore(d.transport);
		await store.openFile('s1', 'src/a.ts', 3);
		expect(store.viewer).toMatchObject({ file: { path: 'src/a.ts' }, line: 3, error: null });
		expect(d.ops.at(-1)).toEqual({ type: 'session.readFile', id: 's1', path: 'src/a.ts' });

		const failing: Transport = {
			...d.transport,
			op: (async () => {
				throw new Error('src/gone.ts is outside the session folder');
			}) as Transport['op']
		};
		const other = new WebStore(failing);
		await other.openFile('s1', 'src/gone.ts');
		expect(other.viewer?.error).toContain('outside');
	});

	it('shows a file containing backtick fences whole, highlighted', () => {
		const content = 'Title\n```js\nlet x = 1;\n```\nafter the fence';
		render(FileViewer, {
			file: { path: 'notes.md', content, truncated: false },
			onclose: vi.fn()
		});
		expect(document.body.textContent).toContain('after the fence');
		expect(document.querySelector('.code-block')).toBeTruthy();
	});

	it('says when only the start is shown', () => {
		render(FileViewer, {
			file: { path: 'big.log', content: 'x'.repeat(300_000), truncated: true },
			onclose: vi.fn()
		});
		expect(screen.getByText('Only the start of this file is shown.')).toBeTruthy();
		// Too big to highlight: plain text.
		expect(document.querySelector('.code-block')).toBeNull();
	});
});

describe('a message', () => {
	const pixel = 'data:image/png;base64,iVBORw0KGgo=';

	it('shows attached images, and opens one full size', async () => {
		render(Message, {
			message: {
				role: 'user',
				content: [
					{ type: 'text', text: 'look at this' },
					{ type: 'image_url', image_url: { url: pixel } }
				]
			}
		});
		expect(screen.getByText('look at this')).toBeTruthy();
		await fireEvent.click(screen.getByTitle('Show full size'));
		expect(screen.getAllByAltText('Attached')).toHaveLength(2);
	});

	it('names an image it cannot show', () => {
		render(Message, {
			message: {
				role: 'user',
				content: [{ type: 'image_url', image_url: { url: 'haruspex-img://localhost/abc' } }]
			}
		});
		expect(screen.getByText(/An image on your computer/)).toBeTruthy();
		expect(screen.queryByAltText('Attached')).toBeNull();
	});

	it('turns a path in an answer into a file link', () => {
		render(Message, {
			message: { role: 'assistant', content: 'Fixed `src/stats.js:5`.' },
			root: '/proj'
		});
		const link = document.querySelector('button[data-action="code-path"]') as HTMLElement;
		expect(link?.dataset.path).toBe('src/stats.js');
		expect(link?.dataset.line).toBe('5');
	});
});

describe('chat in the web store', () => {
	const chatState = (over = {}) => ({
		id: 'c1',
		title: 'Notes',
		messages: [],
		messageSteps: {},
		messageStats: {},
		messageStops: {},
		open: true,
		busy: false,
		waitingForSlot: false,
		compacting: false,
		streamingContent: '',
		searchSteps: [],
		error: null,
		lastTurnFailed: false,
		contextUsage: null,
		workingDir: null,
		memoryEnabled: true,
		...over
	});

	it('follows the open chat from its snapshot, and reads others once', async () => {
		const d = fakeDesktop({ 'chat.get': chatState() });
		const store = new WebStore(d.transport);
		store.start();
		await store.selectChat('c1');
		expect(d.ops.map((o) => o.type)).toEqual(['chat.get', 'chat.resync']);
		d.push({ seq: 4, chatId: 'c1', type: 'chat-update', patch: { busy: true } });
		expect(store.currentChat?.busy).toBe(false);
		d.push({ seq: 5, chatId: 'c1', type: 'chat-snapshot', state: chatState() as never });
		d.push({ seq: 6, chatId: 'c1', type: 'chat-update', patch: { streamingContent: 'Hi' } });
		expect(store.currentChat?.streamingContent).toBe('Hi');

		const other = fakeDesktop({ 'chat.get': chatState({ id: 'c2', open: false }) });
		const s2 = new WebStore(other.transport);
		await s2.selectChat('c2');
		expect(other.ops.map((o) => o.type)).toEqual(['chat.get']);
		store.stop();
	});

	it('keeps chat prompts out of Code sessions, and the reverse', () => {
		const store = new WebStore(fakeDesktop().transport);
		const base = { answerable: true, requester: null, detail: {} };
		store.prompts = {
			'main:1': { ...base, promptId: 'main:1', kind: 'sandbox', sessionId: null, chatId: 'c1' },
			'main:2': { ...base, promptId: 'main:2', kind: 'command', sessionId: 's1' },
			'main:3': { ...base, promptId: 'main:3', kind: 'mcp', sessionId: null }
		};
		expect(store.promptsForChat('c1').map((p) => p.promptId)).toEqual(['main:1', 'main:3']);
		expect(store.promptsFor('s1').map((p) => p.promptId)).toEqual(['main:2', 'main:3']);
	});
});

describe('the composer in a chat', () => {
	it("waits while a reply is written: chat can't be steered", () => {
		render(Composer, { busy: true, steer: false, onsend: vi.fn(), onstop: vi.fn() });
		expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
	});

	it('says why it is disabled while another chat writes', () => {
		render(Composer, {
			busy: false,
			steer: false,
			disabled: true,
			why: 'A reply is being written in "Notes".',
			onsend: vi.fn(),
			onstop: vi.fn()
		});
		expect(screen.getByLabelText('Message').getAttribute('title')).toContain('"Notes"');
	});
});

describe('a sandbox prompt', () => {
	it('answers with the chosen choice', async () => {
		const onanswer = vi.fn();
		render(PromptCard, {
			prompt: {
				promptId: 'main:9',
				kind: 'sandbox',
				sessionId: null,
				chatId: 'c1',
				answerable: true,
				requester: null,
				detail: { code: 'import os' }
			},
			onanswer
		});
		expect(screen.getByText('import os')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Allow for this chat' }));
		expect(onanswer).toHaveBeenCalledWith('main:9', { kind: 'sandbox', choice: 'allow_chat' });
	});
});
