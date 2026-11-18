import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { EngineClient } from '#lib/engine/client.svelte.ts';
import type { StreamEvent, Transport } from '#lib/engine/transport.ts';
import type { SessionState } from '#lib/engine/types.ts';
import { getActiveSessionId, getOpenViews, unregisterOpenView } from '#lib/stores/code.svelte.ts';
import type { PeerView } from './store.svelte.ts';
import {
	MAX_SEND_IMAGES,
	RemoteCodeSession,
	closeRemoteSessionsOf,
	openRemoteSession,
	remoteViewId
} from './remoteCodeSession.svelte.ts';

const state = (over: Partial<SessionState> = {}): SessionState => ({
	id: 's1',
	root: '/home/tim/app',
	wslDistro: null,
	status: 'idle',
	busy: false,
	streamingContent: '',
	roundText: '',
	searchSteps: [],
	messages: [{ role: 'user', content: 'Fix the build' }],
	messageSteps: {},
	messageStats: {},
	messageStops: {},
	title: 'Fix the build',
	usage: null,
	lastError: null,
	saveError: null,
	folderMissing: false,
	steering: ['and add a test'],
	background: [],
	shellWait: null,
	compaction: { at: 0, summary: 'Earlier' },
	compacting: false,
	...over
});

/** Another computer: answers ops from a table, records them and uploads. */
function fakePeer(answers: Record<string, unknown> = {}) {
	const ops: Record<string, unknown>[] = [];
	const uploads: Blob[] = [];
	let push: (e: StreamEvent) => void = () => {};
	const transport: Transport = {
		op: (async (o: Record<string, unknown>) => {
			ops.push(o);
			const a = answers[o.type as string];
			if (a instanceof Error) throw a;
			return typeof a === 'function' ? a(o) : (a ?? null);
		}) as Transport['op'],
		events: (onEvent, onConnection) => {
			push = onEvent;
			onConnection('open');
			return () => {};
		},
		upload: async (b) => {
			uploads.push(b);
			return { hash: `h${uploads.length}` };
		}
	};
	const client = new EngineClient(transport);
	client.start();
	const view = {
		id: 'desk',
		config: { name: 'desk-pc' },
		client,
		get online() {
			return client.connection === 'open';
		}
	} as unknown as PeerView;
	return { view, client, ops, uploads, push: (e: StreamEvent) => push(e) };
}

const of = (ops: Record<string, unknown>[], type: string) => ops.filter((o) => o.type === type);

beforeEach(() => {
	for (const v of getOpenViews()) unregisterOpenView(v.id);
});

describe("another computer's Code session", () => {
	it("reads its state from that computer's mirror", async () => {
		const p = fakePeer({ 'session.get': state() });
		const s = await openRemoteSession(p.view, 's1');
		expect(s.id).toBe('peer:desk:s1');
		expect(getActiveSessionId()).toBe('peer:desk:s1');
		expect(of(p.ops, 'session.open')).toHaveLength(1);
		expect(s.title).toBe('Fix the build');
		expect(s.root).toBe('/home/tim/app');
		expect(s.messages).toEqual([{ role: 'user', content: 'Fix the build' }]);
		expect(s.steering).toEqual([{ text: 'and add a test' }]);
		expect(s.compaction).toEqual({ at: 0, summary: 'Earlier', summarizedAt: 0 });
		expect(s.peer).toEqual({ id: 'desk', name: 'desk-pc' });
		expect(Object.values(s.capabilities).every((on) => !on)).toBe(true);

		p.push({
			seq: 1,
			sessionId: 's1',
			type: 'snapshot',
			state: state({ busy: true, status: 'running' })
		});
		expect(s.busy).toBe(true);
		expect(s.status).toBe('running');
	});

	it('sends each action there as its operation, with that computer’s session id', async () => {
		const p = fakePeer({
			'session.get': state(),
			'session.compact': { started: true },
			'session.fork': { id: 's9', prefill: 'Fix the build' }
		});
		const s = await openRemoteSession(p.view, 's1');
		s.stop();
		s.cancelShellWait();
		s.stopSubtask('bg1');
		expect(await s.compactNow('keep the API')).toBe('compacted');
		await s.setEffort('low');
		await s.setModel({ baseUrl: 'http://box:8080/v1', modelId: 'qwen' });
		await vi.waitFor(() => expect(of(p.ops, 'session.stopBackground')).toHaveLength(1));
		expect(of(p.ops, 'session.stop')).toEqual([{ type: 'session.stop', id: 's1' }]);
		expect(of(p.ops, 'session.cancelShellWait')).toEqual([
			{ type: 'session.cancelShellWait', id: 's1' }
		]);
		expect(of(p.ops, 'session.stopBackground')).toEqual([
			{ type: 'session.stopBackground', id: 's1', processId: 'bg1' }
		]);
		expect(of(p.ops, 'session.compact')).toEqual([
			{ type: 'session.compact', id: 's1', instructions: 'keep the API' }
		]);
		expect(of(p.ops, 'session.effort')).toEqual([
			{ type: 'session.effort', id: 's1', effort: 'low' }
		]);
		expect(s.effort).toBe('low');
		expect(s.model?.modelId).toBe('qwen');

		await s.fork!(1, 'worktree');
		expect(of(p.ops, 'session.fork')).toEqual([
			{ type: 'session.fork', id: 's1', index: 1, mode: 'worktree' }
		]);
		const fork = getOpenViews().find((v) => v.id === remoteViewId('desk', 's9'));
		expect(fork?.prefill).toEqual({ text: 'Fix the build', images: [] });
	});

	it('uploads pictures first, then sends their hashes', async () => {
		const p = fakePeer({ 'session.get': state(), 'session.send': { started: true } });
		const s = await openRemoteSession(p.view, 's1');
		const pic = 'data:image/png;base64,iVBORw0KGgo=';
		await s.send('Look', { images: Array(MAX_SEND_IMAGES + 2).fill(pic) });
		expect(p.uploads).toHaveLength(MAX_SEND_IMAGES);
		expect(p.uploads[0].type).toBe('image/png');
		const sent = of(p.ops, 'session.send')[0];
		expect(sent).toMatchObject({ id: 's1', text: 'Look' });
		expect((sent.images as string[])[0]).toBe('h1');
	});

	it('sends a /name as typed, and shows what a built-in answered', async () => {
		const p = fakePeer({
			'session.get': state(),
			'session.send': (o: { text: string }) =>
				o.text === '/skills'
					? { handled: true, note: 'No skills here.' }
					: { handled: true, id: 's2' }
		});
		const s = await openRemoteSession(p.view, 's1');
		await s.send('/skills');
		expect(s.notes).toEqual([{ text: 'No skills here.', at: 1 }]);
		await s.send('/new');
		expect(getActiveSessionId()).toBe('peer:desk:s2');
	});

	it('keeps a failed operation as its error, and says when that computer is offline', async () => {
		const p = fakePeer({ 'session.get': state(), 'session.stop': new Error('not running') });
		const s = await openRemoteSession(p.view, 's1');
		s.stop();
		await vi.waitFor(() => expect(s.lastError).toBe('not running'));
		expect(s.blockedReason).toBeNull();
		p.client.connection = 'offline';
		expect(s.blockedReason).toBe('desk-pc is offline.');
	});

	it('closing its tab stops following it, and leaves it open there', async () => {
		const p = fakePeer({ 'session.get': state() });
		const s = await openRemoteSession(p.view, 's1');
		expect(p.client.mirrors.s1).toBeDefined();
		closeRemoteSessionsOf('desk');
		expect(getOpenViews()).toEqual([]);
		expect(p.client.mirrors.s1).toBeUndefined();
		expect(of(p.ops, 'session.close')).toEqual([]);
		expect(s).toBeInstanceOf(RemoteCodeSession);
	});
});
