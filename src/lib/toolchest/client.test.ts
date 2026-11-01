import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { ToolchestError, errorBody, hostOf, toolchestBytes, toolchestJson } from './client.ts';

const cfg = { baseUrl: 'http://gpu.lan:8080', apiKey: 'k' };

/** `toolchest_json` failing with `err`, as Rust reports a ComfyError. */
function failWith(err: unknown) {
	tauri.invoke.mockImplementation(
		invokeRouter({
			toolchest_json: () => {
				throw err;
			},
			comfy_cancel: null
		})
	);
}

async function caught(p: Promise<unknown>): Promise<ToolchestError> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(ToolchestError);
		return e as ToolchestError;
	}
	throw new Error('expected a rejection');
}

beforeEach(() => {
	tauri.invoke.mockReset();
});

describe('errorBody', () => {
	it("reads toolchest's message and code", () => {
		expect(errorBody('{"error":{"message":"no model","code":"not_ready"}}')).toEqual({
			message: 'no model',
			code: 'not_ready'
		});
	});

	it('answers nulls for a body that is not JSON, has no error, or empty fields', () => {
		const none = { message: null, code: null };
		expect(errorBody('<html>502</html>')).toEqual(none);
		expect(errorBody('')).toEqual(none);
		expect(errorBody('{"ok":true}')).toEqual(none);
		expect(errorBody('{"error":{"message":"","code":7}}')).toEqual(none);
		expect(errorBody('null')).toEqual(none);
	});
});

describe('hostOf', () => {
	it('names the host and port, and falls back to what it was given', () => {
		expect(hostOf('http://gpu.lan:8080/v1')).toBe('gpu.lan:8080');
		expect(hostOf('not a url')).toBe('not a url');
		expect(hostOf('')).toBe('');
	});
});

describe('toolchestJson', () => {
	it('sends the call to Rust and answers its value', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				toolchest_json: (a) => ({ got: (a as { call: { path: string } }).call.path })
			})
		);
		expect(await toolchestJson(cfg, { path: '/v1/instances' })).toEqual({
			got: '/v1/instances'
		});
	});

	it('says the key was refused on a 401', async () => {
		failWith({ kind: 'rejected', status: 401, body: '' });
		const e = await caught(toolchestJson(cfg, { path: '/v1/x' }));
		expect(e).toMatchObject({ kind: 'rejected', status: 401 });
		expect(e.message).toContain('API key');
	});

	it('says the queue is full, and keeps the code', async () => {
		failWith({
			kind: 'rejected',
			status: 503,
			body: '{"error":{"message":"busy","code":"queue_full"}}'
		});
		const e = await caught(toolchestJson(cfg, { path: '/v1/x' }));
		expect(e).toMatchObject({ kind: 'rejected', status: 503, code: 'queue_full' });
		expect(e.message).toContain('queue is full');
	});

	it("passes on toolchest's own message, or the status when there is none", async () => {
		failWith({ kind: 'rejected', status: 422, body: '{"error":{"message":"bad size"}}' });
		expect((await caught(toolchestJson(cfg, { path: '/v1/x' }))).message).toContain('bad size');
		failWith({ kind: 'rejected', status: 500, body: 'oops' });
		expect((await caught(toolchestJson(cfg, { path: '/v1/x' }))).message).toContain('status 500');
	});

	it('keeps timeout and unreachable apart, and calls invalid a rejection', async () => {
		failWith({ kind: 'timeout', message: 'slow' });
		expect(await caught(toolchestJson(cfg, { path: '/p' }))).toMatchObject({ kind: 'timeout' });
		failWith({ kind: 'unreachable', message: 'refused' });
		expect(await caught(toolchestJson(cfg, { path: '/p' }))).toMatchObject({
			kind: 'unreachable'
		});
		failWith({ kind: 'invalid', message: 'no such file' });
		expect(await caught(toolchestJson(cfg, { path: '/p' }))).toMatchObject({
			kind: 'rejected',
			message: 'no such file'
		});
	});

	it('calls an IPC failure unreachable, and a cancel cancelled', async () => {
		failWith(new Error('bridge gone'));
		const e = await caught(toolchestJson(cfg, { path: '/p' }));
		expect(e.kind).toBe('unreachable');
		expect(e.message).toContain('bridge gone');
		failWith({ kind: 'cancelled' });
		expect(await caught(toolchestJson(cfg, { path: '/p' }))).toMatchObject({ kind: 'cancelled' });
	});

	it('refuses without calling when the signal has already fired', async () => {
		const ac = new AbortController();
		ac.abort();
		expect(await caught(toolchestJson(cfg, { path: '/p' }, ac.signal))).toMatchObject({
			kind: 'cancelled'
		});
		expect(tauri.invoke).not.toHaveBeenCalled();
	});
});

describe('toolchestBytes', () => {
	it('answers bytes whether Rust sends an ArrayBuffer or a number array', async () => {
		tauri.invoke.mockImplementation(invokeRouter({ toolchest_bytes: [1, 2, 3] }));
		expect(Array.from(await toolchestBytes(cfg, '/f'))).toEqual([1, 2, 3]);
		tauri.invoke.mockImplementation(
			invokeRouter({ toolchest_bytes: () => new Uint8Array([4, 5]).buffer })
		);
		expect(Array.from(await toolchestBytes(cfg, '/f'))).toEqual([4, 5]);
	});
});
