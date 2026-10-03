import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as api from './client';
import { ImageBackendError } from '../types';

const cfg = { baseUrl: 'http://box:8188/', apiKey: '' };
const withKey = { baseUrl: 'http://box:8188', apiKey: 'sekrit' };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function ok(body: unknown, init: Partial<Response> = {}): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
		text: async () => JSON.stringify(body),
		arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
		...init
	} as Response;
}

describe('submit', () => {
	it('posts the graph under a `prompt` key with the client id', async () => {
		fetchMock.mockResolvedValue(ok({ prompt_id: 'p1' }));
		const id = await api.submit(cfg, { '1': { class_type: 'X', inputs: {} } }, 'cid');
		expect(id).toBe('p1');
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('http://box:8188/prompt');
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body.client_id).toBe('cid');
		expect(body.prompt['1'].class_type).toBe('X');
	});

	it('rejects a 200 that queued nothing', async () => {
		fetchMock.mockResolvedValue(ok({}));
		await expect(api.submit(cfg, {}, 'cid')).rejects.toMatchObject({ kind: 'rejected' });
	});
});

describe('auth', () => {
	it('sends a bearer header when a key is set', async () => {
		fetchMock.mockResolvedValue(ok({}));
		await api.systemStats(withKey);
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sekrit');
	});

	it('sends no Authorization header at all when none is set', async () => {
		// A bare local ComfyUI has no auth; an empty header is worse than none.
		fetchMock.mockResolvedValue(ok({}));
		await api.systemStats(cfg);
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect(init.headers).not.toHaveProperty('Authorization');
	});
});

describe('failure mapping', () => {
	it('maps a refused connection to `unreachable`', async () => {
		fetchMock.mockRejectedValue(new TypeError('fetch failed'));
		await expect(api.systemStats(cfg)).rejects.toMatchObject({ kind: 'unreachable' });
	});

	it('maps a non-2xx to `rejected`, with status and a clipped body', async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 500,
			text: async () => 'x'.repeat(500)
		} as Response);
		const err = await api.systemStats(cfg).catch((e: ImageBackendError) => e);
		expect(err).toMatchObject({ kind: 'rejected', status: 500 });
		expect((err as ImageBackendError).body).toHaveLength(200);
	});

	it('maps our own abort to `timeout`, not `unreachable`', async () => {
		// An AbortError the caller did not cause is the request deadline.
		const abort = new Error('aborted');
		abort.name = 'AbortError';
		fetchMock.mockRejectedValue(abort);
		await expect(api.systemStats(cfg)).rejects.toMatchObject({ kind: 'timeout' });
	});

	it('maps a caller abort to `cancelled`', async () => {
		const c = new AbortController();
		c.abort();
		const abort = new Error('aborted');
		abort.name = 'AbortError';
		fetchMock.mockRejectedValue(abort);
		await expect(api.history(cfg, 'p1', '9', c.signal)).rejects.toMatchObject({
			kind: 'cancelled'
		});
	});
});

describe('history', () => {
	it('returns null while the prompt is still running', async () => {
		fetchMock.mockResolvedValue(ok({}));
		expect(await api.history(cfg, 'p1', '9')).toBeNull();
	});

	it('returns the output node images once it finishes', async () => {
		fetchMock.mockResolvedValue(
			ok({
				p1: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } }
			})
		);
		expect(await api.history(cfg, 'p1', '9')).toHaveLength(1);
	});

	it('is explicit when the named output node produced nothing', async () => {
		// A workflow whose output node is not the SaveImage node finishes
		// happily and returns no images; the message has to say so.
		fetchMock.mockResolvedValue(ok({ p1: { outputs: { '8': {} } } }));
		await expect(api.history(cfg, 'p1', '9')).rejects.toThrow(/SaveImage/);
	});
});

describe('view', () => {
	it('asks for the file by name, subfolder and type', async () => {
		fetchMock.mockResolvedValue(ok({}));
		await api.view(cfg, { filename: 'a.png', subfolder: 'up', type: 'output' });
		expect(fetchMock.mock.calls[0][0]).toContain('filename=a.png');
		expect(fetchMock.mock.calls[0][0]).toContain('subfolder=up');
	});
});

describe('subscribe', () => {
	class FakeSocket {
		static last: FakeSocket | null = null;
		onmessage: ((e: { data: unknown }) => void) | null = null;
		onerror: (() => void) | null = null;
		onclose: (() => void) | null = null;
		closed = false;
		constructor(readonly url: string) {
			FakeSocket.last = this;
		}
		close() {
			this.closed = true;
		}
	}

	beforeEach(() => {
		FakeSocket.last = null;
		vi.stubGlobal('WebSocket', FakeSocket);
	});

	it('never puts the api key in the socket URL', () => {
		// A socket cannot send headers, and the obvious workaround writes the
		// secret into server logs, proxy logs and browser history. Progress is
		// cosmetic; a secret is not.
		const close = api.subscribe(
			withKey,
			'cid',
			() => {},
			() => {}
		);
		expect(FakeSocket.last!.url).toContain('clientId=cid');
		expect(FakeSocket.last!.url).not.toContain('sekrit');
		close();
	});

	it('translates a progress message into step/totalSteps', () => {
		const seen: unknown[] = [];
		const close = api.subscribe(
			cfg,
			'cid',
			(p) => seen.push(p),
			() => {}
		);
		FakeSocket.last!.onmessage!({
			data: JSON.stringify({ type: 'progress', data: { value: 4, max: 28 } })
		});
		expect(seen[0]).toMatchObject({ phase: 'running', step: 4, totalSteps: 28 });
		close();
	});

	it('reports failure when the socket errors, so the caller can poll instead', () => {
		let failed = false;
		const close = api.subscribe(
			cfg,
			'cid',
			() => {},
			() => {
				failed = true;
			}
		);
		FakeSocket.last!.onerror!();
		expect(failed).toBe(true);
		close();
	});

	it('closes the socket when the returned closer is called', () => {
		const close = api.subscribe(
			cfg,
			'cid',
			() => {},
			() => {}
		);
		close();
		expect(FakeSocket.last!.closed).toBe(true);
	});

	it('survives a message shape it does not know', () => {
		const close = api.subscribe(
			cfg,
			'cid',
			() => {},
			() => {}
		);
		expect(() => FakeSocket.last!.onmessage!({ data: 'not json' })).not.toThrow();
		close();
	});
});

describe('rejectionMessage', () => {
	it('says which node and value ComfyUI refused, not just that it refused', () => {
		const body = JSON.stringify({
			error: {
				type: 'prompt_outputs_failed_validation',
				message: 'Prompt outputs failed validation'
			},
			node_errors: {
				'1': {
					class_type: 'UNETLoader',
					errors: [
						{
							type: 'value_not_in_list',
							message: 'Value not in list',
							details: "unet_name: 'ming.safetensors' not in []"
						}
					]
				}
			}
		});
		expect(api.rejectionMessage('/prompt', body)).toBe(
			"The image backend refused /prompt: UNETLoader — unet_name: 'ming.safetensors' not in [] — " +
				'a file the workflow needs is not on the server (Settings → Image).'
		);
	});

	it("falls back to ComfyUI's own summary, then to the bare refusal", () => {
		expect(api.rejectionMessage('/prompt', '{"error":{"message":"Bad graph"}}')).toBe(
			'The image backend refused /prompt: Bad graph.'
		);
		expect(api.rejectionMessage('/view', 'Not Found')).toBe('The image backend refused /view.');
	});
});

/**
 * Cancelling used to POST /interrupt unconditionally, which stops whatever the
 * server is running: another client's job on a shared ComfyUI included.
 */
describe('cancelPrompt', () => {
	/** A server whose queue holds `running` and `pending`; records each call. */
	function server(queue: { running: string[]; pending: string[] } | 'broken') {
		const calls: Array<{ path: string; method: string; body: unknown }> = [];
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			const path = new URL(url).pathname;
			calls.push({
				path,
				method: init?.method ?? 'GET',
				body: init?.body ? JSON.parse(init.body as string) : undefined
			});
			if (path === '/queue' && (init?.method ?? 'GET') === 'GET') {
				if (queue === 'broken') throw new Error('down');
				const entry = (id: string) => [0, id, {}, {}, []];
				return ok({
					queue_running: queue.running.map(entry),
					queue_pending: queue.pending.map(entry)
				});
			}
			return ok({});
		});
		return calls;
	}

	it('takes a waiting prompt out of the queue, and interrupts nothing', async () => {
		const calls = server({ running: ['theirs'], pending: ['ours'] });
		await api.cancelPrompt(cfg, 'ours');
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /queue', 'POST /queue']);
		expect(calls[1].body).toEqual({ delete: ['ours'] });
	});

	it('interrupts a running prompt by its id', async () => {
		const calls = server({ running: ['ours'], pending: [] });
		await api.cancelPrompt(cfg, 'ours');
		expect(calls.at(-1)).toEqual({
			path: '/interrupt',
			method: 'POST',
			body: { prompt_id: 'ours' }
		});
	});

	it('leaves the server alone when our prompt is not there', async () => {
		const calls = server({ running: ['theirs'], pending: ['theirs too'] });
		await api.cancelPrompt(cfg, 'ours');
		expect(calls.map((c) => c.path)).toEqual(['/queue']);
	});

	it('does nothing at all when the queue cannot be read', async () => {
		const calls = server('broken');
		await expect(api.cancelPrompt(cfg, 'ours')).resolves.toBeUndefined();
		expect(calls.map((c) => c.path)).toEqual(['/queue']);
	});
});
