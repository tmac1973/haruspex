/**
 * The owner API, from the web client. Same-origin requests with the device
 * cookie set by pairing, plus `X-Haruspex: 1`, which the server requires of
 * every cookie-authenticated request (`src-tauri/src/owner/server.rs`).
 */
import type { EngineEvent, EngineOp } from '#lib/engine/types.ts';

const HEADERS = { 'Content-Type': 'application/json', 'X-Haruspex': '1' };

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

async function post<T>(path: string, body: unknown): Promise<T> {
	const r = await fetch(path, {
		method: 'POST',
		headers: HEADERS,
		credentials: 'same-origin',
		body: JSON.stringify(body)
	});
	const json = (await r.json().catch(() => ({}))) as { value?: T; error?: string };
	if (!r.ok) throw new ApiError(r.status, json.error ?? `HTTP ${r.status}`);
	return json.value as T;
}

/** Run an engine operation on the desktop. */
export function op<T = unknown>(operation: EngineOp): Promise<T> {
	return post<T>('/api/v1/op', operation);
}

/** Swap a pairing code for the device cookie. */
export async function pair(code: string): Promise<void> {
	await post('/api/v1/pair', { code });
}

export async function logout(): Promise<void> {
	await post('/api/v1/logout', {});
}

/** `ready` (connected), or an engine event; `resync-all` after falling behind. */
export type StreamEvent = EngineEvent | { type: 'ready' } | { type: 'resync-all' };

export type Connection = 'connecting' | 'open' | 'offline' | 'unauthorised';

/** Split an SSE byte stream into `data:` payloads. Exported for tests. */
export function sseParser(onData: (data: string) => void): (chunk: string) => void {
	let buf = '';
	return (chunk) => {
		buf += chunk.replace(/\r\n/g, '\n');
		let i;
		while ((i = buf.indexOf('\n\n')) >= 0) {
			const frame = buf.slice(0, i);
			buf = buf.slice(i + 2);
			const data = frame
				.split('\n')
				.filter((l) => l.startsWith('data:'))
				.map((l) => l.slice(5).trimStart())
				.join('\n');
			if (data) onData(data);
		}
	};
}

/**
 * Follow the event stream, reconnecting with backoff, until stopped. Not
 * `EventSource`: it can't send `X-Haruspex`, so this reads the stream with
 * `fetch`. A phone that slept reconnects here, and `ready` tells the caller
 * to resync.
 */
export function events(
	onEvent: (e: StreamEvent) => void,
	onConnection: (c: Connection) => void
): () => void {
	let stopped = false;
	let controller: AbortController | null = null;
	let delay = 500;

	async function connect(): Promise<void> {
		while (!stopped) {
			onConnection('connecting');
			controller = new AbortController();
			try {
				const r = await fetch('/api/v1/events', {
					headers: { 'X-Haruspex': '1' },
					credentials: 'same-origin',
					signal: controller.signal
				});
				if (r.status === 401 || r.status === 403) {
					onConnection('unauthorised');
					return;
				}
				if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
				onConnection('open');
				delay = 500;
				const feed = sseParser((data) => {
					try {
						onEvent(JSON.parse(data) as StreamEvent);
					} catch {
						// A frame that isn't JSON: nothing to do with it.
					}
				});
				const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					feed(value);
				}
			} catch {
				if (stopped) return;
			}
			onConnection('offline');
			await new Promise((res) => setTimeout(res, delay));
			delay = Math.min(delay * 2, 10_000);
		}
	}

	void connect();
	return () => {
		stopped = true;
		controller?.abort();
	};
}
