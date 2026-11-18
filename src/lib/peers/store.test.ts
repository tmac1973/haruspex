import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync } from 'svelte';

// The other computers' streams: every listener by event name, to emit to.
const events = vi.hoisted(() => ({
	handlers: [] as { name: string; handler: (e: { payload: unknown }) => void; live: boolean }[]
}));
// What each computer answers.
const remote = vi.hoisted(() => ({ lean: false, kept: null as unknown }));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({
		peers_status: [],
		peer_lists_get: () => remote.kept,
		peer_op: (args) => {
			const { operation } = args as { operation: { type: string } };
			switch (operation.type) {
				case 'app.mode':
					return { lean: remote.lean };
				case 'sessions.list':
					return [
						{
							id: 's1',
							title: 'Fix the build',
							root: '/src/app',
							wslDistro: null,
							status: 'idle',
							window: 'main',
							updatedAt: 5
						}
					];
				case 'chats.list':
					return [
						{
							id: 'c1',
							title: 'Recipes',
							updatedAt: 7,
							open: true,
							busy: false,
							waiting: false,
							unread: true
						}
					];
				default:
					return [];
			}
		}
	})
);
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
		const entry = { name, handler, live: true };
		events.handlers.push(entry);
		return () => (entry.live = false);
	})
}));

import { invoke } from '@tauri-apps/api/core';
import { invokeArgs, invokeCalls } from '#lib/testing/invoke.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import {
	SAVE_LISTS_MS,
	listedChats,
	listedSessions,
	peerView,
	peerViews,
	startPeerStore
} from './store.svelte.ts';

function config(id: string) {
	return {
		instanceId: id,
		name: id,
		address: `${id}.local`,
		port: 8788,
		fingerprint: 'AA:BB',
		auth: 'trusted' as const
	};
}

function emit(name: string, payload: unknown): void {
	for (const h of events.handlers) if (h.live && h.name === name) h.handler({ payload });
}

/** The computer connects: its status, then the server's own `ready`. */
function connect(id: string): void {
	emit('peer://status', { peerId: id, connection: 'open', lastSeen: 1 });
	emit('peer://event', { peerId: id, event: { type: 'ready' } });
}

let stop: () => void = () => {};

beforeEach(async () => {
	vi.useFakeTimers();
	events.handlers = [];
	remote.lean = false;
	remote.kept = null;
	vi.mocked(invoke).mockClear();
	updateSettings({ peersEnabled: true, peers: [config('desk')] });
	stop = startPeerStore();
	flushSync();
	await vi.advanceTimersByTimeAsync(0);
});

afterEach(() => {
	stop();
	vi.useRealTimers();
});

describe('the other computers', () => {
	it('follows Settings: a view per computer, gone with it', async () => {
		expect(peerViews().map((v) => v.id)).toEqual(['desk']);
		updateSettings({ peers: [config('desk'), config('mini')] });
		flushSync();
		const desk = peerView('desk');
		expect(peerViews().map((v) => v.id)).toEqual(['desk', 'mini']);

		updateSettings({ peers: [config('mini')] });
		flushSync();
		expect(peerView('desk')).toBeUndefined();
		expect(desk?.client.connection).toBeDefined();
		// The removed one stopped listening; the other still does.
		await vi.advanceTimersByTimeAsync(0);
		const live = events.handlers.filter((h) => h.live);
		expect(live).toHaveLength(2);

		updateSettings({ peersEnabled: false });
		flushSync();
		expect(peerViews()).toEqual([]);
		expect(events.handlers.filter((h) => h.live)).toHaveLength(0);
	});

	it('keeps its lists once they settle, with only what a list shows', async () => {
		connect('desk');
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		expect(invokeCalls(vi.mocked(invoke), 'peer_lists_save')).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(SAVE_LISTS_MS);
		expect(invokeArgs(vi.mocked(invoke), 'peer_lists_save', -1)).toEqual({
			peerId: 'desk',
			sessions: [{ id: 's1', title: 'Fix the build', root: '/src/app', updatedAt: 5 }],
			chats: [{ id: 'c1', title: 'Recipes', updatedAt: 7 }]
		});
	});

	it('lists live while connected, and as last seen while offline', async () => {
		const view = peerView('desk')!;
		connect('desk');
		await vi.advanceTimersByTimeAsync(0);
		expect(listedSessions(view)).toEqual([
			{
				id: 's1',
				title: 'Fix the build',
				root: '/src/app',
				updatedAt: 5,
				status: 'idle',
				offline: false
			}
		]);
		expect(listedChats(view)[0]).toMatchObject({ id: 'c1', unread: true, offline: false });

		await vi.advanceTimersByTimeAsync(SAVE_LISTS_MS);
		emit('peer://status', { peerId: 'desk', connection: 'offline', lastSeen: 1 });
		expect(listedSessions(view)).toEqual([
			{
				id: 's1',
				title: 'Fix the build',
				root: '/src/app',
				updatedAt: 5,
				status: null,
				offline: true
			}
		]);
		expect(listedChats(view)).toEqual([
			{
				id: 'c1',
				title: 'Recipes',
				updatedAt: 7,
				busy: false,
				waiting: false,
				unread: false,
				offline: true
			}
		]);
	});

	it('shows what was kept before it ever connects', async () => {
		stop();
		remote.kept = {
			sessions: [{ id: 'old', title: 'Old', root: '/x', updatedAt: null }],
			chats: [],
			updatedAt: 3
		};
		stop = startPeerStore();
		flushSync();
		await vi.advanceTimersByTimeAsync(0);
		expect(listedSessions(peerView('desk')!)).toEqual([
			{ id: 'old', title: 'Old', root: '/x', updatedAt: null, status: null, offline: true }
		]);
	});

	it('lists no sessions for a computer in lean mode', async () => {
		remote.lean = true;
		connect('desk');
		await vi.advanceTimersByTimeAsync(0);
		const view = peerView('desk')!;
		expect(view.client.lean).toBe(true);
		expect(listedSessions(view)).toEqual([]);
		expect(listedChats(view)).toHaveLength(1);
	});
});
