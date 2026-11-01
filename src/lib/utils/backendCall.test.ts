import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { fromBackendError, invokeBackend, type Backend } from './backendCall.ts';

class TestError extends Error {
	constructor(
		readonly kind: string,
		message: string
	) {
		super(message);
	}
}

const backend: Backend<TestError> = {
	prefix: 'test',
	server: 'the test server',
	cancelled: () => new TestError('cancelled', 'Cancelled.'),
	error: (kind, message) => new TestError(kind, message),
	rejected: (status, body, path) => new TestError('rejected', `${path} ${status} ${body}`)
};

beforeEach(() => {
	tauri.invoke.mockReset();
});

describe('fromBackendError', () => {
	it("maps each ComfyError kind onto the backend's own error", () => {
		const map = (e: unknown) => fromBackendError(backend, e, '/p');
		expect(map({ kind: 'cancelled' })).toMatchObject({ kind: 'cancelled' });
		expect(map({ kind: 'timeout', message: 'slow' })).toMatchObject({
			kind: 'timeout',
			message: 'slow'
		});
		expect(map({ kind: 'invalid', message: 'bad file' })).toMatchObject({
			kind: 'rejected',
			message: 'bad file'
		});
		expect(map({ kind: 'rejected', status: 422, body: 'no' })).toMatchObject({
			kind: 'rejected',
			message: '/p 422 no'
		});
	});

	it('names the server for an IPC failure, and calls it a cancel when the signal fired', () => {
		expect(fromBackendError(backend, new Error('bridge gone'), '/p')).toMatchObject({
			kind: 'unreachable',
			message: 'The request to the test server failed — bridge gone'
		});
		const ac = new AbortController();
		ac.abort();
		expect(fromBackendError(backend, new Error('raced'), '/p', ac.signal)).toMatchObject({
			kind: 'cancelled'
		});
	});
});

describe('invokeBackend', () => {
	it('passes the id it made to the command and answers its value', async () => {
		tauri.invoke.mockImplementation(invokeRouter({ comfy_json: (a) => a }));
		const out = (await invokeBackend(backend, 'comfy_json', '/p', (id) => ({ id }))) as {
			id: string;
		};
		expect(out.id).toMatch(/^test-\d+$/);
	});

	it('refuses before calling when the signal has already fired', async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(
			invokeBackend(backend, 'comfy_json', '/p', () => ({}), ac.signal)
		).rejects.toMatchObject({ kind: 'cancelled' });
		expect(tauri.invoke).not.toHaveBeenCalled();
	});

	it('stops the call through comfy_cancel when the signal fires mid-call', async () => {
		const ac = new AbortController();
		let callId = '';
		tauri.invoke.mockImplementation(
			invokeRouter({
				comfy_json: (a) => {
					callId = (a as { id: string }).id;
					ac.abort();
					throw { kind: 'cancelled' };
				},
				comfy_cancel: null
			})
		);
		await expect(
			invokeBackend(backend, 'comfy_json', '/p', (id) => ({ id }), ac.signal)
		).rejects.toMatchObject({ kind: 'cancelled' });
		expect(tauri.invoke).toHaveBeenCalledWith('comfy_cancel', { id: callId });
	});
});
