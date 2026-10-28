import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('#lib/stores/chat.svelte.ts', async () => (await import('./chatFake.svelte.ts')).chatStore);
vi.mock(
	'#lib/stores/session.svelte.ts',
	async () => (await import('./chatFake.svelte.ts')).sessionStore
);
vi.mock('#lib/stores/db.ts', () => ({
	dbLoadMessages: vi.fn(async (id: string) => [
		{ role: 'user', content: `stored question in ${id}` },
		{ role: 'assistant', content: 'stored answer' }
	]),
	dbLoadMessageSteps: vi.fn(async () => ({ 1: [{ id: 't1', toolName: 'web_search' }] }))
}));
const slash = vi.hoisted(() => ({ result: { kind: 'send' } as Record<string, unknown> }));
const folders = vi.hoisted(() => ({ exist: new Set(['/home/me/notes']) }));
vi.mock('@tauri-apps/api/core', () => ({
	invoke: async (cmd: string, args: { path: string }) =>
		cmd === 'code_folder_exists' ? folders.exist.has(args.path) : null
}));
vi.mock('#lib/engine/attach.ts', () => ({
	attachImages: async (refs?: string[]) => (refs ?? []).map((r) => `data:image/png;base64,${r}`),
	slashFor: async () => slash.result
}));
vi.mock('#lib/debugLog.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debugLog.ts')>()),
	logDebug: () => {}
}));

import { flushSync } from 'svelte';
import { chatState, dispatchChat, listChats, liveChatState, watchChats } from './chat.svelte.ts';
import { chat, conv, fake, open, reset, setRun } from './chatFake.svelte.ts';
import { emptyChatMirror, reduceChat } from './reduce.ts';
import { LIVE_MS } from './watch.svelte.ts';
import type { ChatEvent } from './types.ts';

async function settle() {
	flushSync();
	await new Promise((r) => setTimeout(r, LIVE_MS * 2));
	flushSync();
}

beforeEach(() => {
	reset();
	fake.conversations.push(conv('a', [{ role: 'user', content: 'hello' }]), conv('b'), conv('c'));
	fake.active = 'a';
});

describe('chat operations', () => {
	it('list every chat with what it is doing', () => {
		setRun('a', { generating: true });
		setRun('b', { generating: true, waitingForSlot: true });
		chat('c').unread = true;
		expect(listChats().map((c) => [c.id, c.open, c.busy, c.waiting, c.unread])).toEqual([
			['a', true, true, false, false],
			['b', false, true, true, false],
			['c', false, false, false, true]
		]);
	});

	it('read an idle chat that is not open from the database, without opening it', async () => {
		const state = await chatState('b');
		expect(state.open).toBe(false);
		expect(state.busy).toBe(false);
		expect(state.messages[0].content).toBe('stored question in b');
		expect(state.messageSteps[1]).toHaveLength(1);
		expect(fake.active).toBe('a');
		expect(fake.opened).toEqual([]);
	});

	it('read the open chat live', async () => {
		setRun('a', { streamingContent: 'Thinking about' });
		const state = await chatState('a');
		expect(state).toMatchObject({ open: true, streamingContent: 'Thinking about' });
		expect(state.workingDir).toBe('/home/me/notes');
	});

	it('read a chat with a turn running live, though it is not open', async () => {
		setRun('b', { generating: true, streamingContent: 'Writing in b' });
		const state = await chatState('b');
		expect(state).toMatchObject({ open: false, busy: true, streamingContent: 'Writing in b' });
	});

	it('count a chat opened on the page as seen', async () => {
		await dispatchChat({ type: 'chat.get', id: 'b' });
		expect(fake.viewed).toEqual(['b']);
	});

	it('send to another chat without opening it on the desktop', async () => {
		expect(await dispatchChat({ type: 'chat.send', id: 'b', text: 'hi b' })).toEqual({
			started: true
		});
		expect(fake.opened).toEqual([]);
		expect(fake.active).toBe('a');
		expect(fake.sent).toEqual([{ id: 'b', text: 'hi b' }]);
	});

	it('send pictures, and the skill a /name named, with the message', async () => {
		slash.result = { kind: 'send', skill: { name: 'fix-picture' } };
		await dispatchChat({ type: 'chat.send', id: 'b', text: '/fix-picture night', images: ['AA'] });
		expect(fake.sent).toEqual([
			{
				id: 'b',
				text: '/fix-picture night',
				images: ['data:image/png;base64,AA'],
				skill: { name: 'fix-picture' }
			}
		]);
		slash.result = { kind: 'send' };
	});

	it('answer what a built-in said instead of sending it', async () => {
		slash.result = { kind: 'handled', id: 'new-chat' };
		expect(await dispatchChat({ type: 'chat.send', id: 'b', text: '/new' })).toEqual({
			handled: true,
			id: 'new-chat',
			note: undefined
		});
		expect(fake.sent).toEqual([]);
		slash.result = { kind: 'send' };
	});

	it('delete a chat, stopping its turn', async () => {
		setRun('b', { generating: true });
		expect(await dispatchChat({ type: 'chat.delete', id: 'b' })).toEqual({ deleted: 'b' });
		expect(fake.cancelled).toEqual(['b']);
		expect(fake.conversations.map((c) => c.id)).toEqual(['a', 'c']);
	});

	it('rename a chat, and turn its memory off', async () => {
		await dispatchChat({ type: 'chat.rename', id: 'b', title: '  Trip plans ' });
		expect(chat('b').title).toBe('Trip plans');
		await expect(dispatchChat({ type: 'chat.rename', id: 'b', title: ' ' })).rejects.toThrow(
			'needs a title'
		);
		await dispatchChat({ type: 'chat.memory', id: 'b', enabled: false });
		expect(chat('b').memoryEnabled).toBe(false);
		chat('c').isRemote = true;
		await expect(dispatchChat({ type: 'chat.memory', id: 'c', enabled: true })).rejects.toThrow(
			'never remembered'
		);
	});

	it("set Chat's working folder to one that exists, or clear it", async () => {
		expect(await dispatchChat({ type: 'chat.folder', path: '/home/me/notes' })).toEqual({
			workingDir: '/home/me/notes'
		});
		expect(fake.workingDir).toBe('/home/me/notes');
		await expect(dispatchChat({ type: 'chat.folder', path: '/nope' })).rejects.toThrow(
			'no folder /nope'
		);
		await dispatchChat({ type: 'chat.folder', path: null });
		expect(fake.workingDir).toBeNull();
	});

	it('steer a chat whose reply is being written, while another runs beside it', async () => {
		setRun('a', { generating: true });
		expect(await dispatchChat({ type: 'chat.send', id: 'a', text: 'also this' })).toEqual({
			started: true
		});
		expect(fake.steered).toEqual([{ id: 'a', text: 'also this' }]);
		expect(await dispatchChat({ type: 'chat.send', id: 'b', text: 'y' })).toEqual({
			started: true
		});
		expect(fake.sent).toEqual([{ id: 'b', text: 'y' }]);
	});

	it('say so when chat refuses to send', async () => {
		fake.accept = false;
		await expect(dispatchChat({ type: 'chat.send', id: 'a', text: 'x' })).rejects.toThrow(
			"isn't ready"
		);
	});

	it('stop the chat named, and only while it writes', async () => {
		expect(await dispatchChat({ type: 'chat.stop', id: 'b' })).toEqual({ stopping: false });
		setRun('a', { generating: true });
		setRun('b', { generating: true });
		expect(await dispatchChat({ type: 'chat.stop', id: 'b' })).toEqual({ stopping: true });
		expect(fake.cancelled).toEqual(['b']);
		expect(fake.runs.a.generating).toBe(true);
	});

	it('continue and retry the chat named, refusing one that is busy', async () => {
		await dispatchChat({ type: 'chat.continue', id: 'b' });
		await dispatchChat({ type: 'chat.retry', id: 'c' });
		expect(fake.continued).toEqual(['b']);
		expect(fake.retried).toEqual(['c']);
		expect(fake.opened).toEqual([]);
		setRun('b', { generating: true });
		await expect(dispatchChat({ type: 'chat.continue', id: 'b' })).rejects.toThrow('this chat');
	});
});

describe('chat events', () => {
	let events: ChatEvent[];
	let stop: () => void;

	beforeEach(() => {
		events = [];
		stop = watchChats((e) => events.push(e)).stop;
	});
	afterEach(() => stop());

	const mirrorOf = (id: string) =>
		events.filter((e) => e.chatId === id).reduce(reduceChat, emptyChatMirror());

	it('rebuild the open chat as a reply streams and is saved', async () => {
		await settle();
		expect(events[0]).toMatchObject({ type: 'chat-snapshot', chatId: 'a', seq: 1 });

		setRun('a', { generating: true, streamingContent: 'Partial' });
		await settle();
		expect(mirrorOf('a').state).toEqual(liveChatState(open()!));

		const c = open()!;
		c.messages = [...c.messages, { role: 'assistant', content: 'Partial answer.' }];
		setRun('a', { generating: false, streamingContent: '' });
		await settle();
		const m = mirrorOf('a');
		expect(m.resync).toBe(false);
		expect(m.state).toEqual(liveChatState(open()!));
		expect(m.state?.messages.at(-1)?.content).toBe('Partial answer.');
	});

	it('follow a chat that is not open while its turn runs, and let it go after', async () => {
		await settle();
		expect(events.some((e) => e.chatId === 'b')).toBe(false);

		setRun('b', { generating: true, streamingContent: 'Writing in b' });
		await settle();
		expect(mirrorOf('b').state).toMatchObject({
			id: 'b',
			open: false,
			busy: true,
			streamingContent: 'Writing in b'
		});

		chat('b').messages = [{ role: 'assistant', content: 'Done in b.' }];
		setRun('b', { generating: false, streamingContent: '' });
		await settle();
		const b = mirrorOf('b');
		expect(b.resync).toBe(false);
		expect(b.state).toMatchObject({ busy: false, streamingContent: '' });
		expect(b.state?.messages.at(-1)?.content).toBe('Done in b.');

		const count = events.length;
		chat('b').title = 'Renamed';
		await settle();
		expect(events.length).toBe(count);
	});

	it('follow two chats at once, each with its own stream', async () => {
		setRun('a', { generating: true, streamingContent: 'in a' });
		setRun('b', { generating: true, streamingContent: 'in b' });
		await settle();
		expect(mirrorOf('a').state?.streamingContent).toBe('in a');
		expect(mirrorOf('b').state?.streamingContent).toBe('in b');
	});

	it('start following once a chat opens, when none was open at first', async () => {
		stop();
		fake.active = null;
		events = [];
		stop = watchChats((e) => events.push(e)).stop;
		await settle();
		expect(events).toEqual([]);
		fake.active = 'b';
		await settle();
		setRun('b', { generating: true, streamingContent: 'Writing' });
		await settle();
		const b = mirrorOf('b');
		expect(b.state).toMatchObject({ id: 'b', busy: true, streamingContent: 'Writing' });
		expect(b.resync).toBe(false);
	});

	it('let one chat go and follow the next when the desktop switches', async () => {
		await settle();
		fake.active = 'b';
		await settle();
		const left = mirrorOf('a').state!;
		expect(left).toMatchObject({ open: false, busy: false, streamingContent: '' });
		expect(mirrorOf('b').state).toMatchObject({ id: 'b', open: true });
	});

	it('keep following a chat left on the desktop while its turn still runs', async () => {
		setRun('a', { generating: true, streamingContent: 'still going' });
		await settle();
		fake.active = 'b';
		await settle();
		expect(mirrorOf('a').state).toMatchObject({
			open: false,
			busy: true,
			streamingContent: 'still going'
		});
	});
});

describe('the chat mirror', () => {
	it('asks for a resync on a gap and keeps what it had', () => {
		const snap = {
			seq: 1,
			chatId: 'a',
			type: 'chat-snapshot',
			state: { id: 'a', busy: false }
		} as unknown as ChatEvent;
		let m = reduceChat(emptyChatMirror(), snap);
		m = reduceChat(m, { seq: 3, chatId: 'a', type: 'chat-update', patch: { busy: true } });
		expect(m.resync).toBe(true);
		expect(m.state?.busy).toBe(false);
	});
});
