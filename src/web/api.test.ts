import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	ApiError,
	events,
	logout,
	lookupImages,
	op,
	pair,
	upload,
	type Connection
} from './api.ts';
import type { StreamEvent } from './api.ts';
import type { EngineOp } from '#lib/engine/types.ts';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});

/** A response whose SSE body the test writes to and closes. */
function sseResponse() {
	let ctl!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			ctl = c;
		}
	});
	const enc = new TextEncoder();
	return {
		response: new Response(body, { status: 200 }),
		write: (s: string) => ctl.enqueue(enc.encode(s)),
		close: () => ctl.close(),
		fail: () => ctl.error(new Error('dropped'))
	};
}

/** Let pending promises and stream reads settle; timers stay frozen. */
async function settle() {
	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('op', () => {
	it('returns the value from a 2xx answer', async () => {
		fetchMock.mockResolvedValue(json({ value: { id: 's1' } }));
		await expect(op({ type: 'list' } as unknown as EngineOp)).resolves.toEqual({ id: 's1' });
	});

	it('POSTs the operation as JSON with the X-Haruspex header', async () => {
		fetchMock.mockResolvedValue(json({ value: null }));
		const operation = { type: 'list' } as unknown as EngineOp;
		await op(operation);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/op');
		expect(init?.method).toBe('POST');
		expect(init?.credentials).toBe('same-origin');
		expect(init?.headers).toMatchObject({ 'X-Haruspex': '1' });
		expect(JSON.parse(init?.body as string)).toEqual(operation);
	});

	it("turns a non-2xx answer into an ApiError carrying the server's message", async () => {
		fetchMock.mockResolvedValue(json({ error: 'no such session' }, 404));
		const err = await op({ type: 'x' } as unknown as EngineOp).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(404);
		expect((err as ApiError).message).toBe('no such session');
	});

	it('falls back to the status when the error body is not JSON', async () => {
		fetchMock.mockResolvedValue(new Response('oops', { status: 500 }));
		const err = await op({ type: 'x' } as unknown as EngineOp).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(500);
		expect((err as ApiError).message).toContain('500');
	});

	it('reports 401 as an ApiError with that status', async () => {
		fetchMock.mockResolvedValue(json({ error: 'unpaired' }, 401));
		await expect(op({ type: 'x' } as unknown as EngineOp)).rejects.toMatchObject({
			status: 401
		});
	});

	it('lets a network failure through as it is', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		const err = await op({ type: 'x' } as unknown as EngineOp).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TypeError);
		expect(err).not.toBeInstanceOf(ApiError);
	});
});

describe('lookupImages', () => {
	it('returns the images map', async () => {
		const images = { 'https://a/b.png': { hash: 'h' } };
		fetchMock.mockResolvedValue(json({ images }));
		await expect(lookupImages(['https://a/b.png'])).resolves.toEqual(images);
		expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
			urls: ['https://a/b.png']
		});
	});

	it('throws an ApiError on a non-2xx answer', async () => {
		fetchMock.mockResolvedValue(json({ error: 'nope' }, 403));
		await expect(lookupImages([])).rejects.toMatchObject({ status: 403 });
		await expect(lookupImages([])).rejects.toBeInstanceOf(ApiError);
	});
});

describe('upload', () => {
	it('POSTs the bytes with their content type and returns the hash', async () => {
		fetchMock.mockResolvedValue(json({ hash: 'abc' }));
		const file = new Blob(['png-bytes'], { type: 'image/png' });
		await expect(upload(file)).resolves.toEqual({ hash: 'abc' });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/upload');
		expect(init?.method).toBe('POST');
		expect(init?.body).toBe(file);
		expect(init?.headers).toMatchObject({ 'X-Haruspex': '1', 'Content-Type': 'image/png' });
	});

	it('sends an untyped blob as application/octet-stream', async () => {
		fetchMock.mockResolvedValue(json({ hash: 'abc' }));
		await upload(new Blob(['x']));
		expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
			'Content-Type': 'application/octet-stream'
		});
	});

	it("throws the server's error on a non-2xx answer", async () => {
		fetchMock.mockResolvedValue(json({ error: 'too large' }, 413));
		await expect(upload(new Blob(['x']))).rejects.toMatchObject({
			status: 413,
			message: 'too large'
		});
	});

	it('throws when a 2xx answer has no hash', async () => {
		fetchMock.mockResolvedValue(json({}));
		await expect(upload(new Blob(['x']))).rejects.toBeInstanceOf(ApiError);
	});

	it('lets a network failure through', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		await expect(upload(new Blob(['x']))).rejects.toBeInstanceOf(TypeError);
	});
});

describe('pair and logout', () => {
	it('pair sends the code and resolves on success', async () => {
		fetchMock.mockResolvedValue(json({}));
		await expect(pair('123456')).resolves.toBeUndefined();
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/pair');
		expect(JSON.parse(init?.body as string)).toEqual({ code: '123456' });
	});

	it('pair rejects a wrong code with the status and message', async () => {
		fetchMock.mockResolvedValue(json({ error: 'wrong code' }, 401));
		await expect(pair('000000')).rejects.toMatchObject({ status: 401, message: 'wrong code' });
	});

	it('logout POSTs to the logout route', async () => {
		fetchMock.mockResolvedValue(json({}));
		await logout();
		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/logout');
	});

	it('logout surfaces a server error', async () => {
		fetchMock.mockResolvedValue(new Response('', { status: 500 }));
		await expect(logout()).rejects.toMatchObject({ status: 500 });
	});
});

describe('events', () => {
	function follow() {
		const got: StreamEvent[] = [];
		const states: Connection[] = [];
		const stop = events(
			(e) => got.push(e),
			(c) => states.push(c)
		);
		return { got, states, stop };
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	});

	it('opens, then hands parsed events to the callback', async () => {
		const sse = sseResponse();
		fetchMock.mockResolvedValue(sse.response);
		const { got, states, stop } = follow();
		await settle();
		expect(states).toEqual(['connecting', 'open']);

		sse.write('data: {"type":"ready"}\n\n');
		sse.write('data: {"type":"resync-');
		sse.write('all"}\n\n');
		await settle();
		expect(got).toEqual([{ type: 'ready' }, { type: 'resync-all' }]);
		stop();
	});

	it('sends the X-Haruspex header and skips frames that are not JSON', async () => {
		const sse = sseResponse();
		fetchMock.mockResolvedValue(sse.response);
		const { got, stop } = follow();
		await settle();
		expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ 'X-Haruspex': '1' });
		sse.write('data: not json\n\ndata: {"type":"ready"}\n\n');
		await settle();
		expect(got).toEqual([{ type: 'ready' }]);
		stop();
	});

	it('goes offline when the stream ends and reconnects after the delay', async () => {
		const first = sseResponse();
		const second = sseResponse();
		fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
		const { states, stop } = follow();
		await settle();
		first.close();
		await settle();
		expect(states).toEqual(['connecting', 'open', 'offline']);

		await vi.advanceTimersByTimeAsync(499);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(states).toEqual(['connecting', 'open', 'offline', 'connecting', 'open']);
		stop();
	});

	it('goes offline when the stream errors mid-read', async () => {
		const sse = sseResponse();
		fetchMock.mockResolvedValueOnce(sse.response).mockReturnValue(new Promise(() => {}));
		const { states, stop } = follow();
		await settle();
		sse.fail();
		await settle();
		expect(states.at(-1)).toBe('offline');
		stop();
	});

	it('backs off, doubling the delay while the desktop stays unreachable', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		const { states, stop } = follow();
		await settle();
		expect(states).toEqual(['connecting', 'offline']);

		await vi.advanceTimersByTimeAsync(500);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// Second wait is 1000 ms, not 500.
		await vi.advanceTimersByTimeAsync(500);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(500);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(3);
		stop();
	});

	it('treats a non-2xx answer other than 401/403 as offline', async () => {
		fetchMock.mockResolvedValue(new Response('', { status: 502 }));
		const { states, stop } = follow();
		await settle();
		expect(states).toEqual(['connecting', 'offline']);
		stop();
	});

	it.each([401, 403])('stops for good on %i and reports unauthorised', async (status) => {
		fetchMock.mockResolvedValue(new Response('', { status }));
		const { states } = follow();
		await settle();
		expect(states).toEqual(['connecting', 'unauthorised']);
		await vi.advanceTimersByTimeAsync(30_000);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('stop() ends an open stream without reporting offline or reconnecting', async () => {
		const sse = sseResponse();
		fetchMock.mockResolvedValue(sse.response);
		const { states, stop } = follow();
		await settle();
		stop();
		await settle();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(states).toEqual(['connecting', 'open']);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('stop() during the backoff wait prevents another attempt', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		const { stop } = follow();
		await settle();
		stop();
		await vi.advanceTimersByTimeAsync(30_000);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
