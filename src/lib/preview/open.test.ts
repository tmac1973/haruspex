import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const emitTo = vi.fn();
const getByLabel = vi.fn();
const openAppWindow = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: (...a: unknown[]) => emitTo(...a) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
	WebviewWindow: { getByLabel: (...a: unknown[]) => getByLabel(...a) }
}));
vi.mock('#lib/appWindow.ts', () => ({ openAppWindow: (...a: unknown[]) => openAppWindow(...a) }));

import { openPreview, previewRoute, reloadUrl } from './open';

const URL_ = 'http://127.0.0.1:4100/abc/my%20site/index.html';

beforeEach(() => {
	vi.clearAllMocks();
	invoke.mockResolvedValue({ url: URL_ });
});

describe('openPreview', () => {
	it('opens a window for the session when none is open', async () => {
		getByLabel.mockResolvedValue(null);
		const url = await openPreview('s1', '/proj', 'my site/index.html');
		expect(url).toBe(URL_);
		expect(invoke).toHaveBeenCalledWith('preview_serve', {
			sessionId: 's1',
			root: '/proj',
			path: 'my site/index.html'
		});
		const spec = openAppWindow.mock.calls[0][0];
		expect(spec.label).toBe('preview-s1');
		expect(spec.title).toBe('Preview — my site/index.html');
		const q = new URLSearchParams(spec.url.split('?')[1]);
		expect(spec.url.startsWith('/preview?')).toBe(true);
		expect(q.get('url')).toBe(URL_);
		expect(q.get('path')).toBe('my site/index.html');
		expect(emitTo).not.toHaveBeenCalled();
	});

	it('points an open window at the page and raises it', async () => {
		const win = { unminimize: vi.fn().mockResolvedValue(undefined), setFocus: vi.fn() };
		win.setFocus.mockResolvedValue(undefined);
		getByLabel.mockResolvedValue(win);
		await openPreview('s1', '/proj', 'a.html');
		expect(emitTo).toHaveBeenCalledWith('preview-s1', 'preview://navigate', {
			url: URL_,
			path: 'a.html'
		});
		expect(win.setFocus).toHaveBeenCalled();
		expect(openAppWindow).not.toHaveBeenCalled();
	});

	it("passes on the server's refusal", async () => {
		invoke.mockRejectedValue('Not found: a.html');
		await expect(openPreview('s1', '/proj', 'a.html')).rejects.toBe('Not found: a.html');
		expect(openAppWindow).not.toHaveBeenCalled();
	});
});

describe('preview urls', () => {
	it('encodes a path with # and spaces in the route', () => {
		const r = previewRoute('s', URL_, 'a b#c.html');
		expect(new URLSearchParams(r.split('?')[1]).get('path')).toBe('a b#c.html');
	});

	it('replaces the cache-buster rather than adding another', () => {
		const once = reloadUrl(URL_, 1);
		expect(reloadUrl(once, 2)).toBe(URL_ + '?_r=2');
	});
});
