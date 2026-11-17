import { describe, it, expect, vi, beforeEach } from 'vitest';

const events = vi.hoisted(() => ({
	handlers: new Map<string, (e: { payload: unknown }) => void>(),
	unlistened: [] as string[]
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
		events.handlers.set(name, handler);
		return () => events.unlistened.push(name);
	})
}));

import { invoke } from '@tauri-apps/api/core';
import { ApiError, type Connection, type StreamEvent } from '#lib/engine/transport.ts';
import { invokeArgs, invokeRouter } from '#lib/testing/invoke.ts';
import { peerTransport } from './transport.ts';

const DESK = 'desk';

function emit(name: string, payload: unknown): void {
	events.handlers.get(name)!({ payload });
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	events.handlers.clear();
	events.unlistened = [];
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockImplementation(invokeRouter({ peers_status: [] }));
});

describe('peer transport', () => {
	it("passes on only this computer's events", async () => {
		const got: StreamEvent[] = [];
		const stop = peerTransport(DESK).events(
			(e) => got.push(e),
			() => {}
		);
		await settle();
		emit('peer://event', { peerId: 'other', event: { type: 'ready' } });
		emit('peer://event', { peerId: DESK, event: { type: 'resync-all' } });
		expect(got).toEqual([{ type: 'resync-all' }]);
		stop();
		expect(events.unlistened.sort()).toEqual(['peer://event', 'peer://status']);
	});

	it('maps each status onto a connection, and passes the status on', async () => {
		const connections: Connection[] = [];
		const statuses: string[] = [];
		peerTransport(DESK, (s) => statuses.push(s.connection)).events(
			() => {},
			(c) => connections.push(c)
		);
		await settle();
		for (const connection of ['connecting', 'open', 'offline', 'notLetIn', 'certificateChanged'])
			emit('peer://status', { peerId: DESK, connection, lastSeen: null });
		emit('peer://status', { peerId: 'other', connection: 'open', lastSeen: null });
		expect(connections).toEqual(['connecting', 'open', 'offline', 'unauthorised', 'unauthorised']);
		expect(statuses).toEqual(['connecting', 'open', 'offline', 'notLetIn', 'certificateChanged']);
	});

	it('says ready when the stream was already open before it listened', async () => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter({ peers_status: [{ peerId: DESK, connection: 'open', lastSeen: 1 }] })
		);
		const got: StreamEvent[] = [];
		const connections: Connection[] = [];
		peerTransport(DESK).events(
			(e) => got.push(e),
			(c) => connections.push(c)
		);
		await settle();
		expect(connections).toEqual(['open']);
		expect(got).toEqual([{ type: 'ready' }]);
	});

	it("turns Rust's errors into statuses the client knows", async () => {
		const t = peerTransport(DESK);
		for (const [message, status] of [
			['offline', 0],
			['not let in', 401],
			['certificate changed', 495],
			['session not found', 500]
		] as const) {
			vi.mocked(invoke).mockRejectedValueOnce(message);
			const err = await t.op({ type: 'sessions.list' }).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(status);
			expect((err as ApiError).message).toBe(message);
		}
		expect(invokeArgs(vi.mocked(invoke), 'peer_op')).toEqual({
			peerId: DESK,
			operation: { type: 'sessions.list' }
		});
	});

	it('uploads the raw bytes, naming the computer and the type in headers', async () => {
		vi.mocked(invoke).mockResolvedValueOnce({ hash: 'h' });
		const out = await peerTransport(DESK).upload(
			new Blob([new Uint8Array([1, 2])], { type: 'image/png' })
		);
		expect(out).toEqual({ hash: 'h' });
		const [cmd, body, options] = vi.mocked(invoke).mock.calls[0];
		expect(cmd).toBe('peer_upload');
		expect(Array.from(body as Uint8Array)).toEqual([1, 2]);
		expect(options).toEqual({ headers: { 'x-peer-id': DESK, 'content-type': 'image/png' } });
	});
});
