import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The app's path: every call goes through Rust (`src-tauri/src/comfy.rs`). */
const tauri = vi.hoisted(() => ({
	invoke: vi.fn(),
	channels: [] as Array<{ onmessage: (ev: unknown) => void }>
}));
vi.mock('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	invoke: tauri.invoke,
	Channel: class {
		onmessage: (ev: unknown) => void = () => {};
		constructor() {
			tauri.channels.push(this);
		}
	}
}));

import * as api from './client';

const cfg = { baseUrl: 'http://box:8188', apiKey: 'sekrit' };

beforeEach(() => {
	tauri.invoke.mockReset();
	tauri.channels.length = 0;
});

describe('requests through Rust', () => {
	it('sends the call with its key, body and a cancel id; nothing goes through fetch', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		tauri.invoke.mockResolvedValue({ prompt_id: 'p1' });
		expect(await api.submit(cfg, {}, 'cid')).toBe('p1');
		const [cmd, args] = tauri.invoke.mock.calls[0];
		expect(cmd).toBe('comfy_json');
		expect(args.call).toMatchObject({
			base_url: 'http://box:8188',
			api_key: 'sekrit',
			method: 'POST',
			path: '/prompt',
			body: { prompt: {}, client_id: 'cid' }
		});
		expect(args.call.id).toMatch(/^comfy-/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('maps each Rust error onto the kind callers branch on', async () => {
		tauri.invoke.mockRejectedValueOnce({ kind: 'unreachable', message: 'Could not reach it' });
		await expect(api.systemStats(cfg)).rejects.toMatchObject({
			kind: 'unreachable',
			message: 'Could not reach it'
		});
		tauri.invoke.mockRejectedValueOnce({ kind: 'timeout', message: 'late' });
		await expect(api.systemStats(cfg)).rejects.toMatchObject({ kind: 'timeout' });
		tauri.invoke.mockRejectedValueOnce({ kind: 'rejected', status: 400, body: 'bad graph' });
		await expect(api.systemStats(cfg)).rejects.toMatchObject({
			kind: 'rejected',
			status: 400,
			body: 'bad graph'
		});
	});

	it('cancels the Rust call when the caller aborts', async () => {
		const c = new AbortController();
		let reject: (e: unknown) => void = () => {};
		tauri.invoke.mockImplementation((cmd: string) =>
			cmd === 'comfy_json' ? new Promise((_, r) => (reject = r)) : Promise.resolve(undefined)
		);
		const pending = api.history(cfg, 'p1', '9', c.signal);
		c.abort();
		const cancel = tauri.invoke.mock.calls.find(([cmd]) => cmd === 'comfy_cancel');
		expect(cancel?.[1].id).toBe(tauri.invoke.mock.calls[0][1].call.id);
		reject({ kind: 'cancelled' });
		await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
	});

	it('fetches image bytes as bytes', async () => {
		tauri.invoke.mockResolvedValue(new Uint8Array([7, 8]).buffer);
		const bytes = await api.view(cfg, { filename: 'a.png', subfolder: '', type: 'output' });
		expect(tauri.invoke.mock.calls[0][0]).toBe('comfy_bytes');
		expect(Array.from(bytes)).toEqual([7, 8]);
	});
});

describe('the progress socket through Rust', () => {
	it('opens with the key (Rust sends it as a header) and forwards progress', async () => {
		tauri.invoke.mockResolvedValue(undefined);
		const seen: unknown[] = [];
		const close = api.subscribe(
			cfg,
			'cid',
			(p) => seen.push(p),
			() => {}
		);
		const [cmd, args] = tauri.invoke.mock.calls[0];
		expect(cmd).toBe('comfy_subscribe');
		expect(args).toMatchObject({ baseUrl: 'http://box:8188', apiKey: 'sekrit', clientId: 'cid' });
		tauri.channels[0].onmessage({ kind: 'message', type: 'progress', value: 3, max: 12 });
		expect(seen).toEqual([{ phase: 'running', step: 3, totalSteps: 12 }]);
		close();
		expect(tauri.invoke).toHaveBeenLastCalledWith('comfy_cancel', { id: args.id });
	});

	it('reports failure when the socket cannot open, so the caller polls instead', async () => {
		tauri.invoke.mockRejectedValue({ kind: 'unreachable', message: 'refused' });
		let failed = false;
		api.subscribe(
			cfg,
			'cid',
			() => {},
			() => (failed = true)
		);
		await vi.waitFor(() => expect(failed).toBe(true));
	});
});
