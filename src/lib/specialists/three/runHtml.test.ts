import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { invoke } from '@tauri-apps/api/core';

import { LATE_MS, SETTLE_MS, runAssetHtml, type AssetRunResult } from './runHtml';

/** The run's iframe, and what the parent posted to it. */
function frame() {
	const iframe = document.querySelector('iframe');
	if (!iframe?.contentWindow) throw new Error('no iframe');
	const win = iframe.contentWindow;
	const posted: string[] = [];
	vi.spyOn(win, 'postMessage').mockImplementation((m: unknown) => {
		posted.push((m as { t: string }).t);
	});
	const send = (data: unknown, source: MessageEventSource | null = win) =>
		window.dispatchEvent(new MessageEvent('message', { data, source }));
	return { iframe, posted, send };
}

/** Start a run and wait for its iframe to appear. */
async function start(opts: Parameters<typeof runAssetHtml>[1] = {}) {
	let settled: AssetRunResult | Error | undefined;
	const run = runAssetHtml('<html><head></head><body></body></html>', opts).then(
		(r) => (settled = r),
		(e: Error) => (settled = e)
	);
	await vi.advanceTimersByTimeAsync(0);
	return { run, f: frame(), settled: () => settled };
}

const PNG = 'data:image/png;base64,AAAA';

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockResolvedValue('doc-1');
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

describe('runAssetHtml', () => {
	it('registers the shimmed page and loads it sandboxed and off-screen', async () => {
		const { f } = await start();
		expect(invoke).toHaveBeenCalledWith('artifact_register', {
			html: expect.stringMatching(/^<html><head><script>\(function/)
		});
		expect(f.iframe.getAttribute('sandbox')).toBe('allow-scripts');
		expect(f.iframe.src).toContain('doc-1');
		expect(f.iframe.style.left).toBe('-10000px');
		expect(f.iframe.style.display).not.toBe('none');
	});

	it('with export, takes the snapshot then the GLB, and collects late errors', async () => {
		const { run, f, settled } = await start();
		f.send({ t: 'hx-err', kind: 'console', message: 'early', line: null });
		f.send({ t: 'hx-ready' });
		await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
		expect(f.posted).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(f.posted).toEqual(['hx-snapshot']);
		f.send({ t: 'hx-png', dataUrl: PNG });
		expect(f.posted).toEqual(['hx-snapshot', 'hx-export']);
		f.send({ t: 'hx-glb', bytes: new Uint8Array([103, 108, 84, 70]).buffer });
		f.send({ t: 'hx-err', kind: 'error', message: 'late', line: 42, col: 7 });
		await vi.advanceTimersByTimeAsync(LATE_MS - 1);
		expect(settled()).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		const r = (await run) as AssetRunResult;
		expect(r.png).toBe(PNG);
		expect([...r.glb!]).toEqual([103, 108, 84, 70]);
		expect(r.errors).toEqual([
			{ kind: 'console', message: 'early', line: null },
			{ kind: 'error', message: 'late', line: 42 }
		]);
		expect(document.querySelector('iframe')).toBeNull();
	});

	it('ends at once on a missing export button, with no timeout', async () => {
		const { run, f } = await start();
		f.send({ t: 'hx-ready' });
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		f.send({ t: 'hx-png', dataUrl: PNG });
		f.send({ t: 'hx-err', kind: 'no-export', message: 'No Export GLB button found.' });
		const r = (await run) as AssetRunResult;
		expect(r.glb).toBeNull();
		expect(r.errors.map((e) => e.kind)).toEqual(['no-export']);
		expect(document.querySelector('iframe')).toBeNull();
	});

	it('without export, never asks for one and resolves on the snapshot', async () => {
		const { run, f } = await start({ export: false });
		f.send({ t: 'hx-ready' });
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		f.send({ t: 'hx-png', dataUrl: PNG });
		await vi.advanceTimersByTimeAsync(LATE_MS);
		const r = (await run) as AssetRunResult;
		expect(f.posted).toEqual(['hx-snapshot']);
		expect(r).toEqual({ glb: null, png: PNG, errors: [] });
	});

	it('returns no snapshot for a page with no canvas', async () => {
		const { run, f } = await start({ export: false });
		f.send({ t: 'hx-ready' });
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		f.send({ t: 'hx-png', dataUrl: null });
		await vi.advanceTimersByTimeAsync(LATE_MS);
		expect(((await run) as AssetRunResult).png).toBeNull();
	});

	it('ignores messages from another source', async () => {
		const { run, f } = await start({ timeoutMs: 5000 });
		f.send({ t: 'hx-ready' }, null);
		f.send({ t: 'hx-err', kind: 'error', message: 'not ours', line: 1 }, null);
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.posted).toEqual([]);
		const r = (await run) as AssetRunResult;
		expect(r.errors).toEqual([
			{ kind: 'timeout', message: expect.stringContaining('the page to load'), line: null }
		]);
	});

	it('on a timeout, returns what arrived', async () => {
		const { run, f } = await start({ timeoutMs: 5000 });
		f.send({ t: 'hx-err', kind: 'error', message: 'boom', line: 9 });
		f.send({ t: 'hx-ready' });
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		f.send({ t: 'hx-png', dataUrl: PNG });
		await vi.advanceTimersByTimeAsync(5000);
		const r = (await run) as AssetRunResult;
		expect(r.png).toBe(PNG);
		expect(r.glb).toBeNull();
		expect(r.errors).toEqual([
			{ kind: 'error', message: 'boom', line: 9 },
			{ kind: 'timeout', message: expect.stringContaining('the GLB export'), line: null }
		]);
		expect(document.querySelector('iframe')).toBeNull();
	});

	it('on abort, cleans up and rejects with AbortError', async () => {
		const ac = new AbortController();
		const removed = vi.spyOn(window, 'removeEventListener');
		const { run, f } = await start({ signal: ac.signal });
		f.send({ t: 'hx-ready' });
		ac.abort();
		const e = (await run) as Error;
		expect(e.name).toBe('AbortError');
		expect(document.querySelector('iframe')).toBeNull();
		expect(removed).toHaveBeenCalledWith('message', expect.any(Function));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.posted).toEqual([]);
	});

	it('rejects before registering when already aborted', async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(runAssetHtml('<html></html>', { signal: ac.signal })).rejects.toMatchObject({
			name: 'AbortError'
		});
		expect(invoke).not.toHaveBeenCalled();
	});
});
