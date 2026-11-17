/**
 * A `Transport` (`#lib/engine/transport.ts`) to another computer, through
 * Rust: operations and uploads by command, events from the stream Rust keeps
 * per computer (`peers/manager.rs`). The same `EngineClient` the web page
 * uses runs over it.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import {
	ApiError,
	type Connection,
	type StreamEvent,
	type Transport
} from '#lib/engine/transport.ts';
import type { EngineOp } from '#lib/engine/types.ts';
import type { PeerConnection } from '#lib/ipc/gen/PeerConnection.ts';
import type { PeerStatus } from '#lib/ipc/gen/PeerStatus.ts';
import { errMessage } from '#lib/utils/error.ts';

/** Rust's errors the client acts on, by their exact text (`peers/mod.rs`). */
const STATUS_FOR: Record<string, number> = {
	offline: 0,
	'not let in': 401,
	// nginx's "SSL certificate error": not a status a server sends us.
	'certificate changed': 495
};

/** Rust's error as an `ApiError`, so `EngineClient` treats a 401 as the web page does. */
export function peerError(e: unknown): ApiError {
	const message = errMessage(e);
	return new ApiError(STATUS_FOR[message] ?? 500, message);
}

export function connectionFor(status: PeerConnection): Connection {
	switch (status) {
		case 'open':
			return 'open';
		case 'connecting':
			return 'connecting';
		case 'offline':
			return 'offline';
		default:
			return 'unauthorised';
	}
}

/**
 * `onStatus` hears each of the computer's statuses as Rust reports it, for
 * telling a changed certificate from a refusal, which `Connection` doesn't.
 */
export function peerTransport(peerId: string, onStatus?: (s: PeerStatus) => void): Transport {
	return {
		async op<T>(operation: EngineOp): Promise<T> {
			try {
				return await invoke<T>('peer_op', { peerId, operation });
			} catch (e) {
				throw peerError(e);
			}
		},

		events(onEvent: (e: StreamEvent) => void, onConnection: (c: Connection) => void) {
			let stopped = false;
			const stops: UnlistenFn[] = [];
			const status = (s: PeerStatus): void => {
				onStatus?.(s);
				onConnection(connectionFor(s.connection));
			};
			void (async () => {
				const listening = await Promise.all([
					listen<{ peerId: string; event: StreamEvent }>('peer://event', (e) => {
						if (e.payload.peerId === peerId) onEvent(e.payload.event);
					}),
					listen<PeerStatus>('peer://status', (e) => {
						if (e.payload.peerId === peerId) status(e.payload);
					})
				]);
				if (stopped) return listening.forEach((stop) => stop());
				stops.push(...listening);
				// Its stream may have opened before this window listened, and
				// the `ready` that opened it went by: say it again.
				const now = (await invoke<PeerStatus[] | null>('peers_status'))?.find(
					(s) => s.peerId === peerId
				);
				if (stopped || !now) return;
				status(now);
				if (now.connection === 'open') onEvent({ type: 'ready' });
			})().catch((e: unknown) => console.warn('Other computers: events', e));
			return () => {
				stopped = true;
				stops.forEach((stop) => stop());
			};
		},

		async upload(file: Blob): Promise<{ hash: string }> {
			const bytes = new Uint8Array(await file.arrayBuffer());
			try {
				return await invoke<{ hash: string }>('peer_upload', bytes, {
					headers: {
						'x-peer-id': peerId,
						'content-type': file.type || 'application/octet-stream'
					}
				});
			} catch (e) {
				throw peerError(e);
			}
		}
	};
}
