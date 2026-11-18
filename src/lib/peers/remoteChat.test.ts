import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync } from 'svelte';

// That computer: what each operation answers, and every one asked for.
const desk = vi.hoisted(() => ({
	ops: [] as Record<string, unknown>[],
	answers: {} as Record<string, unknown>,
	listeners: [] as { name: string; handler: (e: { payload: unknown }) => void }[]
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({
		peers_status: [{ peerId: 'desk', connection: 'open', lastSeen: 1 }],
		peer_lists_get: null,
		peer_upload: () => ({ hash: `h${desk.ops.filter((o) => o.type === 'upload').length}` }),
		peer_op: (args) => {
			const { operation } = args as { operation: Record<string, unknown> };
			desk.ops.push(operation);
			const a = desk.answers[operation.type as string];
			if (typeof a === 'function') return a(operation);
			return a ?? null;
		}
	})
);
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
		desk.listeners.push({ name, handler });
		return () => {};
	})
}));

import type { ChatState } from '#lib/engine/types.ts';
import { getActiveChatSource } from '#lib/stores/activeChatSource.svelte.ts';
import { localChatSource } from '#lib/stores/chat.svelte.ts';
import { peerView, reconcilePeerViews } from './store.svelte.ts';
import {
	MAX_CHAT_IMAGES,
	RemoteChatSource,
	deleteRemoteChat,
	openRemoteChat
} from './remoteChat.svelte.ts';

const config = {
	instanceId: 'desk',
	name: 'desk-pc',
	address: 'desk-pc.local',
	port: 8788,
	fingerprint: 'AA:BB',
	auth: 'trusted' as const
};

const chat = (over: Partial<ChatState> = {}): ChatState => ({
	id: 'c1',
	title: 'Recipes',
	messages: [{ role: 'user', content: 'Soup ideas?' }],
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

function push(event: unknown): void {
	for (const l of desk.listeners)
		if (l.name === 'peer://event') l.handler({ payload: { peerId: 'desk', event } });
}

const of = (type: string) => desk.ops.filter((o) => o.type === type);

async function open(): Promise<RemoteChatSource> {
	reconcilePeerViews([config]);
	await vi.waitFor(() => expect(peerView('desk')?.online).toBe(true));
	return openRemoteChat(peerView('desk')!, 'c1');
}

beforeEach(() => {
	desk.ops = [];
	desk.listeners = [];
	desk.answers = { 'chat.get': chat() };
});

afterEach(() => {
	reconcilePeerViews([]);
});

describe("another computer's chat", () => {
	it('shows in the Chat view, read from its snapshot and patches', async () => {
		const s = await open();
		expect(getActiveChatSource()).toBe(s);
		expect(s.peer).toEqual({ id: 'desk', name: 'desk-pc' });
		expect(s.conversation?.title).toBe('Recipes');
		expect(s.remembered).toBe(true);
		// Its own memory switch: not a guest thread.
		expect(s.isRemote).toBe(false);

		push({ seq: 1, chatId: 'c1', type: 'chat-snapshot', state: chat() });
		push({
			seq: 2,
			chatId: 'c1',
			type: 'chat-update',
			patch: { busy: true, streamingContent: 'Try' }
		});
		flushSync();
		expect(s.isGenerating).toBe(true);
		expect(s.streamingContent).toBe('Try');
	});

	it('has the capabilities a chat there can use', async () => {
		const s = await open();
		expect(s.capabilities).toEqual({
			deepResearch: false,
			workingFolder: false,
			incognito: true,
			screenCapture: true,
			mic: true,
			localServer: false,
			openInShell: false
		});
	});

	it('sends each action there as its operation', async () => {
		desk.answers['chat.send'] = { started: true };
		const s = await open();
		expect(await s.sendMessage('More please')).toBe(true);
		s.cancelGeneration();
		await s.continueTurn();
		await s.retryLastTurn();
		await s.setMemoryEnabled('c1', false);
		await vi.waitFor(() => expect(of('chat.stop')).toHaveLength(1));
		expect(of('chat.send')).toEqual([
			{ type: 'chat.send', id: 'c1', text: 'More please', images: [] }
		]);
		expect(of('chat.stop')).toEqual([{ type: 'chat.stop', id: 'c1' }]);
		expect(of('chat.continue')).toEqual([{ type: 'chat.continue', id: 'c1' }]);
		expect(of('chat.retry')).toEqual([{ type: 'chat.retry', id: 'c1' }]);
		expect(of('chat.memory')).toEqual([{ type: 'chat.memory', id: 'c1', enabled: false }]);
	});

	it('uploads pictures first, at most eight, and sends their hashes', async () => {
		desk.answers['chat.send'] = { started: true };
		const s = await open();
		const pic = 'data:image/png;base64,iVBORw0KGgo=';
		await s.sendMessage('Look', Array(MAX_CHAT_IMAGES + 1).fill(pic));
		const sent = of('chat.send')[0];
		expect((sent.images as string[]).length).toBe(MAX_CHAT_IMAGES);
	});

	it("sends a /name as typed, and shows a built-in's note", async () => {
		desk.answers['chat.send'] = { handled: true, note: 'No skills here.' };
		const s = await open();
		await s.sendMessage('/skills');
		const msgs = s.conversation!.messages;
		expect(msgs.at(-1)).toEqual({ role: 'assistant', content: 'No skills here.' });
	});

	it('says when that computer is offline', async () => {
		const s = await open();
		for (const l of desk.listeners)
			if (l.name === 'peer://status')
				l.handler({ payload: { peerId: 'desk', connection: 'offline', lastSeen: 1 } });
		expect(s.errorMessage).toBe('desk-pc is offline.');
	});

	it('goes back to this computer’s chats when it is deleted, or the computer removed', async () => {
		await open();
		await deleteRemoteChat(peerView('desk')!, 'c1');
		expect(of('chat.delete')).toEqual([{ type: 'chat.delete', id: 'c1' }]);
		expect(getActiveChatSource()).toBe(localChatSource);

		await openRemoteChat(peerView('desk')!, 'c1');
		expect(getActiveChatSource()).toBeInstanceOf(RemoteChatSource);
		reconcilePeerViews([]);
		expect(getActiveChatSource()).toBe(localChatSource);
	});
});
