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
vi.mock('#lib/debug-log.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debug-log.ts')>()),
	logDebug: () => {}
}));

import { flushSync } from 'svelte';
import { chatState, dispatchChat, listChats, openChatState, watchChats } from './chat.svelte.ts';
import { conv, fake, open, reset } from './chatFake.svelte.ts';
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
	fake.conversations.push(conv('a', [{ role: 'user', content: 'hello' }]), conv('b'));
	fake.active = 'a';
});

describe('chat operations', () => {
	it('list every chat, marking the open one and the one writing', () => {
		fake.generating = true;
		expect(listChats().map((c) => [c.id, c.open, c.busy])).toEqual([
			['a', true, true],
			['b', false, false]
		]);
	});

	it('read a chat that is not open from the database, without opening it', async () => {
		const state = await chatState('b');
		expect(state.open).toBe(false);
		expect(state.messages[0].content).toBe('stored question in b');
		expect(state.messageSteps[1]).toHaveLength(1);
		expect(fake.active).toBe('a');
		expect(fake.opened).toEqual([]);
	});

	it('read the open chat live', async () => {
		fake.streaming = 'Thinking about';
		const state = await chatState('a');
		expect(state).toMatchObject({ open: true, streamingContent: 'Thinking about' });
		expect(state.workingDir).toBe('/home/me/notes');
	});

	it('send to another chat by opening it first', async () => {
		expect(await dispatchChat({ type: 'chat.send', id: 'b', text: 'hi b' })).toEqual({
			started: true
		});
		expect(fake.opened).toEqual(['b']);
		expect(fake.sent).toEqual([{ id: 'b', text: 'hi b' }]);
	});

	it('refuse a send while a reply is being written', async () => {
		fake.generating = true;
		await expect(dispatchChat({ type: 'chat.send', id: 'b', text: 'x' })).rejects.toThrow(
			'"Chat a"'
		);
		await expect(dispatchChat({ type: 'chat.send', id: 'a', text: 'x' })).rejects.toThrow(
			'this chat'
		);
		expect(fake.sent).toEqual([]);
	});

	it('say so when chat refuses to send', async () => {
		fake.accept = false;
		await expect(dispatchChat({ type: 'chat.send', id: 'a', text: 'x' })).rejects.toThrow(
			"isn't ready"
		);
	});

	it('stop only the open chat, and only while it writes', async () => {
		expect(await dispatchChat({ type: 'chat.stop', id: 'a' })).toEqual({ stopping: false });
		fake.generating = true;
		expect(await dispatchChat({ type: 'chat.stop', id: 'b' })).toEqual({ stopping: false });
		expect(await dispatchChat({ type: 'chat.stop', id: 'a' })).toEqual({ stopping: true });
		expect(fake.cancelled).toBe(1);
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

		fake.generating = true;
		fake.streaming = 'Partial';
		await settle();
		expect(mirrorOf('a').state).toEqual(openChatState(open()!));

		const c = open()!;
		c.messages = [...c.messages, { role: 'assistant', content: 'Partial answer.' }];
		fake.streaming = '';
		fake.generating = false;
		await settle();
		const m = mirrorOf('a');
		expect(m.resync).toBe(false);
		expect(m.state).toEqual(openChatState(open()!));
		expect(m.state?.messages.at(-1)?.content).toBe('Partial answer.');
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
		fake.generating = true;
		fake.streaming = 'Writing';
		await settle();
		const b = mirrorOf('b');
		expect(b.state).toMatchObject({ id: 'b', busy: true, streamingContent: 'Writing' });
		expect(b.resync).toBe(false);
	});

	it('close one chat and open the next when the desktop switches', async () => {
		await settle();
		fake.active = 'b';
		await settle();
		const left = mirrorOf('a').state!;
		expect(left).toMatchObject({ open: false, busy: false, streamingContent: '' });
		expect(mirrorOf('b').state).toMatchObject({ id: 'b', open: true });
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
