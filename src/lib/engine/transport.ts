/**
 * How an `EngineClient` (`client.svelte.ts`) reaches a Haruspex: run an
 * operation, follow its events, and upload a picture. The web client does it
 * over HTTP (`src/web/api.ts`); the desktop reaches another computer through
 * Rust (plan/archive/instance-sync/).
 */
import type { EngineEvent, EngineOp } from '#lib/engine/types.ts';

/** A failed request, with the HTTP status that says why. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

/** `ready` (connected), or an engine event; `resync-all` after falling behind. */
export type StreamEvent = EngineEvent | { type: 'ready' } | { type: 'resync-all' };

export type Connection = 'connecting' | 'open' | 'offline' | 'unauthorised';

export interface Transport {
	/** Run an engine operation, answering its value. */
	op<T = unknown>(operation: EngineOp): Promise<T>;
	/** Follow the event stream, reconnecting, until the returned stop is called. */
	events(onEvent: (e: StreamEvent) => void, onConnection: (c: Connection) => void): () => void;
	/** Keep a picture there for a message; a send's `images` takes the hash. */
	upload(file: Blob): Promise<{ hash: string }>;
}
