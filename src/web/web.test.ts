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
import Transcript from './components/Transcript.svelte';
import ChatTranscript from './components/ChatTranscript.svelte';
import ChatList from './components/ChatList.svelte';
import { imageRefs, resetImages, wantImages } from './images.ts';
import { clearResolvedImages } from '#lib/images/resolve.svelte.ts';
import { VIEW_IMAGE_EVENT } from '#lib/markdownActions.ts';

// jsdom can't decode a picture: an attached file stands for itself.
vi.mock('#lib/utils/image.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/utils/image.ts')>()),
	imageFileToDataUrl: async (f: File) => `data:${f.type};base64,${f.name}`
}));

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

/** A desktop that answers ops from a table and lets the test push events. */
function fakeDesktop(answers: Record<string, unknown> = {}) {
	const ops: { type: string }[] = [];
	const uploads: Blob[] = [];
	let push: (e: StreamEvent) => void = () => {};
	const transport: Transport = {
		upload: async (b: Blob) => {
			uploads.push(b);
			return { hash: `${uploads.length}`.padStart(64, '0') };
		},
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
	return { transport, ops, uploads, push: (e: StreamEvent) => push(e) };
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
	it("follows the desktop's lean mode: Chat only", async () => {
		const d = fakeDesktop({ 'app.mode': { lean: true }, 'chats.list': [] });
		const store = new WebStore(d.transport);
		expect(store.tab).toBe('code');
		await store.refreshMode();
		expect(store.lean).toBe(true);
		expect(store.tab).toBe('chat');

		// A desktop from before `app.mode` answers nothing useful: not lean.
		const old = new WebStore(fakeDesktop().transport);
		await old.refreshMode();
		expect(old.lean).toBe(false);
		expect(old.tab).toBe('code');
	});

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

	it('runs /compact as a command, not a message', async () => {
		const d = fakeDesktop({ 'session.compact': { started: true } });
		const store = new WebStore(d.transport);
		expect(await store.send('s1', '/compact keep the API notes')).toBe(true);
		expect(d.ops).toContainEqual({
			type: 'session.compact',
			id: 's1',
			instructions: 'keep the API notes'
		});
		expect(d.ops.some((o) => o.type === 'session.send')).toBe(false);
		expect(store.error).toBeNull();

		const short = fakeDesktop({ 'session.compact': { started: false } });
		const store2 = new WebStore(short.transport);
		await store2.send('s1', '/compact');
		expect(store2.error).toContain('Nothing to summarise yet');
		// Anything else is a message, even one that mentions the command.
		await store2.send('s1', 'what does /compact do?');
		expect(short.ops.at(-1)).toMatchObject({ type: 'session.send' });
	});

	it('uploads pictures first, then sends their hashes with the message', async () => {
		const d = fakeDesktop({ 'session.send': { started: true } });
		const store = new WebStore(d.transport);
		const png = 'data:image/png;base64,iVBORw==';
		expect(await store.send('s1', 'what is wrong here?', [png, png])).toBe(true);
		expect(d.uploads.map((b) => b.type)).toEqual(['image/png', 'image/png']);
		expect(d.ops.at(-1)).toEqual({
			type: 'session.send',
			id: 's1',
			text: 'what is wrong here?',
			images: ['1'.padStart(64, '0'), '2'.padStart(64, '0')]
		});
	});

	it("sends nothing when a picture doesn't upload", async () => {
		const d = fakeDesktop();
		d.transport.upload = async () => {
			throw new Error('a picture can be at most 16 MB');
		};
		const store = new WebStore(d.transport);
		expect(await store.sendChat('c1', 'look', ['data:image/png;base64,AA'])).toBe(false);
		expect(store.error).toBe('a picture can be at most 16 MB');
		expect(d.ops.some((o) => o.type === 'chat.send')).toBe(false);
	});

	it('shows what a built-in such as /skills answers, and opens the chat /new made', async () => {
		const d = fakeDesktop({ 'chat.send': { handled: true, note: 'Skills you can run…' } });
		const store = new WebStore(d.transport);
		await store.sendChat('c1', '/skills');
		expect(store.note).toBe('Skills you can run…');

		const made = fakeDesktop({ 'chat.send': { handled: true, id: 'c2' }, 'chats.list': [] });
		const store2 = new WebStore(made.transport);
		await store2.sendChat('c1', '/new');
		expect(store2.selectedChat).toBe('c2');
	});

	it('asks for a new session in a worktree', async () => {
		const d = fakeDesktop({ 'session.new': { id: 'n' } });
		const store = new WebStore(d.transport);
		await store.newSession(' /p ', null, true);
		expect(d.ops).toContainEqual({
			type: 'session.new',
			root: '/p',
			wslDistro: null,
			worktree: true
		});
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

	it('answers an MCP approval', async () => {
		const onanswer = vi.fn();
		render(PromptCard, {
			prompt: {
				promptId: 'main:3',
				kind: 'mcp',
				sessionId: null,
				answerable: true,
				requester: null,
				detail: {
					server: 'GitHub',
					tool: 'create_issue',
					annotations: null,
					args: { title: 'Bug' }
				}
			},
			onanswer
		});
		expect(screen.getByText('Allow GitHub to run create_issue?')).toBeTruthy();
		expect(screen.getByText(/"title": "Bug"/)).toBeTruthy();
		await fireEvent.click(screen.getByText('Always allow'));
		expect(onanswer).toHaveBeenCalledWith('main:3', { kind: 'mcp', choice: 'allow_always' });
	});

	it('saves a skill as edited, or rejects it with a reason', async () => {
		const onanswer = vi.fn();
		render(PromptCard, {
			prompt: {
				promptId: 'main:4',
				kind: 'skill',
				sessionId: null,
				answerable: true,
				requester: null,
				detail: { kind: 'skill', name: 'release', update: false, dir: '/s', text: 'v1' }
			},
			onanswer
		});
		const editor = screen.getByLabelText('SKILL.md') as HTMLTextAreaElement;
		expect(editor.value).toBe('v1');
		await fireEvent.input(editor, { target: { value: 'v2' } });
		await fireEvent.click(screen.getByText('Save'));
		expect(onanswer).toHaveBeenLastCalledWith('main:4', {
			kind: 'skill',
			action: 'save',
			text: 'v2'
		});
		await fireEvent.input(screen.getByLabelText('Reason, if you reject it'), {
			target: { value: 'not now' }
		});
		await fireEvent.click(screen.getByText('Reject'));
		expect(onanswer).toHaveBeenLastCalledWith('main:4', {
			kind: 'skill',
			action: 'reject',
			reason: 'not now'
		});
	});

	it('answers the repo-trust question', async () => {
		const onanswer = vi.fn();
		render(PromptCard, {
			prompt: {
				promptId: 'main:5',
				kind: 'repo-trust',
				sessionId: null,
				answerable: true,
				requester: null,
				detail: { root: '/src/app', skills: 2, agentsMd: true, change: null }
			},
			onanswer
		});
		expect(screen.getByText(/2 skills and an AGENTS.md/)).toBeTruthy();
		await fireEvent.click(screen.getByText('Ignore them'));
		expect(onanswer).toHaveBeenCalledWith('main:5', { kind: 'repo-trust', trust: false });
	});

	it("answers the assistant's screenshot prompt", async () => {
		const onanswer = vi.fn();
		render(PromptCard, {
			prompt: {
				promptId: 'main:6',
				kind: 'screen-capture',
				sessionId: null,
				chatId: 'c1',
				answerable: true,
				requester: null,
				detail: { target: 'screen' }
			},
			onanswer
		});
		expect(screen.getByText('Take a screenshot?')).toBeTruthy();
		await fireEvent.click(screen.getByText("Don't"));
		expect(onanswer).toHaveBeenCalledWith('main:6', { kind: 'screen-capture', choice: 'deny' });
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
		await vi.waitFor(() => expect(onsend).toHaveBeenCalledWith('fix it', []));
		expect(box.value).toBe('fix it');
		ok = true;
		await fireEvent.keyDown(box, { key: 'Enter' });
		await vi.waitFor(() => expect(box.value).toBe(''));
	});

	it('sends attached pictures, with or without text, and can drop one', async () => {
		const onsend = vi.fn(async () => true);
		const { container } = render(Composer, { busy: false, onsend, onstop: vi.fn() });
		const input = container.querySelector('input[type=file]') as HTMLInputElement;
		const files = [
			new File(['a'], 'one', { type: 'image/png' }),
			new File(['b'], 'two', { type: 'image/png' })
		];
		Object.defineProperty(input, 'files', { value: files, configurable: true });
		await fireEvent.change(input);
		await vi.waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
		await fireEvent.click(screen.getByLabelText('Remove picture 1'));
		await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
		await vi.waitFor(() => expect(onsend).toHaveBeenCalledWith('', ['data:image/png;base64,two']));
		await vi.waitFor(() => expect(screen.queryAllByRole('img')).toHaveLength(0));
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

	it('shows attached images, and asks for one full size', async () => {
		const asked = vi.fn();
		document.addEventListener(VIEW_IMAGE_EVENT, asked);
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
		expect((asked.mock.calls[0][0] as CustomEvent).detail.src).toBe(pixel);
		document.removeEventListener(VIEW_IMAGE_EVENT, asked);
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

describe("an answer's pictures", () => {
	const hash = 'a'.repeat(64);
	const row = {
		hash,
		source_url: 'https://example.com/cat.png',
		source: 'web',
		mime: 'image/png',
		width: 4,
		height: 3,
		bytes: 9,
		license: null,
		attribution: null,
		description_url: null,
		embeddable: true,
		created_at: 0,
		last_used_at: 0
	};

	function desktopWith(images: Record<string, unknown>) {
		const asks: string[][] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_path: string, init: RequestInit) => {
				const urls = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
				asks.push(urls);
				const found = Object.fromEntries(urls.flatMap((u) => (images[u] ? [[u, images[u]]] : [])));
				return new Response(JSON.stringify({ images: found }));
			})
		);
		return asks;
	}

	it('reads the image URLs written in a message', () => {
		expect(
			imageRefs('a ![cat](https://example.com/cat.png) b ![](haruspex-img://localhost/x)')
		).toEqual(['https://example.com/cat.png', 'haruspex-img://localhost/x']);
	});

	it("shows one from the desktop's cache, and asks once", async () => {
		resetImages();
		clearResolvedImages();
		const asks = desktopWith({ 'https://example.com/cat.png': row });
		const message = {
			role: 'assistant' as const,
			content: 'A cat: ![cat](https://example.com/cat.png)'
		};
		render(Message, { message });
		render(Message, { message });
		await vi.waitFor(() => expect(document.querySelectorAll('img[alt="cat"]')).toHaveLength(2));
		expect((document.querySelector('img[alt="cat"]') as HTMLImageElement).src).toContain(hash);
		expect(asks).toEqual([['https://example.com/cat.png']]);
		vi.unstubAllGlobals();
	});

	it('asks again about a miss, twice', async () => {
		vi.useFakeTimers();
		resetImages();
		clearResolvedImages();
		const asks = desktopWith({});
		wantImages(['https://example.com/late.png']);
		await vi.advanceTimersByTimeAsync(0);
		expect(asks).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(3000);
		expect(asks).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(60000);
		expect(asks).toHaveLength(3);
		vi.useRealTimers();
		vi.unstubAllGlobals();
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

	it('shows a summary as a divider, with the messages it summarised still above', async () => {
		render(ChatTranscript, {
			chat: chatState({
				messages: [
					{ role: 'user', content: 'old question' },
					{ role: 'assistant', content: 'old answer' },
					{ role: 'system', content: '[Earlier conversation summary]\nThey asked once.' },
					{ role: 'user', content: 'new question' }
				]
			}) as never,
			oncontinue: () => {},
			onretry: () => {}
		});
		const divider = screen.getByTestId('chat-summary');
		expect(screen.getByText('old question')).toBeTruthy();
		expect(divider.nextElementSibling!.textContent).toContain('new question');
		await fireEvent.click(screen.getByText('Earlier messages summarised'));
		expect(divider.textContent).toContain('They asked once.');
		expect(divider.textContent).not.toContain('[Earlier conversation summary]');
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

	it('follows a chat with a turn running though it is not open on the desktop', async () => {
		const d = fakeDesktop({ 'chat.get': chatState({ open: false, busy: true }) });
		const store = new WebStore(d.transport);
		store.start();
		await store.selectChat('c1');
		expect(d.ops.map((o) => o.type)).toEqual(['chat.get', 'chat.resync']);
		store.stop();
	});

	it('picks up the events of a chat it read once, from the snapshot its turn starts with', async () => {
		const d = fakeDesktop({ 'chat.get': chatState({ open: false }) });
		const store = new WebStore(d.transport);
		store.start();
		await store.selectChat('c1');
		// A send from the page starts a turn there; the desktop starts following it.
		d.push({
			seq: 7,
			chatId: 'c1',
			type: 'chat-snapshot',
			state: chatState({ busy: true }) as never
		});
		d.push({ seq: 8, chatId: 'c1', type: 'chat-update', patch: { streamingContent: 'Hi' } });
		expect(store.currentChat).toMatchObject({ busy: true, streamingContent: 'Hi' });
		store.stop();
	});

	it('marks each chat with what it is doing, and blocks no other chat', () => {
		const store = new WebStore(fakeDesktop().transport);
		const item = (id: string, over = {}) => ({
			id,
			title: id,
			updatedAt: 0,
			open: false,
			busy: false,
			waiting: false,
			unread: false,
			...over
		});
		store.chats = [
			item('writing', { busy: true }),
			item('waiting', { busy: true, waiting: true }),
			item('new', { unread: true }),
			item('open', { open: true })
		];
		render(ChatList, { store });
		for (const mark of ['Writing', 'Waiting', 'New', 'Open']) {
			expect(screen.getByText(mark)).toBeTruthy();
		}
		expect((screen.getByRole('button', { name: 'New chat' }) as HTMLButtonElement).disabled).toBe(
			false
		);
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

describe('the composer', () => {
	it('waits while busy when it may not steer', () => {
		render(Composer, { busy: true, steer: false, onsend: vi.fn(), onstop: vi.fn() });
		expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
	});

	it('says why it is disabled', () => {
		render(Composer, {
			busy: false,
			disabled: true,
			why: 'Folder not found.',
			onsend: vi.fn(),
			onstop: vi.fn()
		});
		expect(screen.getByLabelText('Message').getAttribute('title')).toContain('Folder not found');
	});

	it('steers a busy chat: the box stays open, with Stop beside Send', async () => {
		const onsend = vi.fn(async () => true);
		render(Composer, { busy: true, onsend, onstop: vi.fn() });
		const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
		expect(box.disabled).toBe(false);
		expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
		await fireEvent.input(box, { target: { value: 'also this' } });
		await fireEvent.keyDown(box, { key: 'Enter' });
		expect(onsend).toHaveBeenCalledWith('also this', []);
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

describe('the transcript and compaction', () => {
	const messages = [
		{ role: 'user' as const, content: 'question 1' },
		{ role: 'assistant' as const, content: 'answer 1' },
		{ role: 'user' as const, content: 'question 2' },
		{ role: 'assistant' as const, content: 'answer 2' }
	];

	it('marks where the summary ends, above the first message the agent sees whole', async () => {
		render(Transcript, {
			session: state({ messages, compaction: { at: 2, summary: 'Asked one question.' } }),
			oncontinue: () => {},
			onopenfile: () => {}
		});
		const divider = screen.getByTestId('compaction');
		expect(divider.nextElementSibling!.textContent).toContain('question 2');
		await fireEvent.click(screen.getByText('Earlier turns summarised'));
		expect(divider.textContent).toContain('Asked one question.');
		// Everything above the cut still shows.
		expect(screen.getByText('question 1')).toBeTruthy();
	});

	it('says when it is summarising', () => {
		render(Transcript, {
			session: state({ status: 'running', busy: true, compacting: true }),
			oncontinue: () => {},
			onopenfile: () => {}
		});
		expect(screen.getByText('Summarising earlier turns…')).toBeTruthy();
	});
});
