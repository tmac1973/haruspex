import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({
	invoke: vi.fn(),
	calls: [] as string[]
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/window', () => ({
	getCurrentWindow: () => ({
		hide: async () => void tauri.calls.push('hide'),
		show: async () => void tauri.calls.push('show'),
		setFocus: async () => void tauri.calls.push('focus')
	})
}));

import { finishRegionCapture, sourceRect, startRegionCapture } from './captureRegion';

beforeEach(() => {
	tauri.invoke.mockReset();
	tauri.calls.length = 0;
});

const shown = { width: 960, height: 540 };
const source = { width: 3840, height: 2160 };

describe('turning a drag on the preview into a region of the screen', () => {
	it('scales the drag up to the full-resolution frame', () => {
		expect(sourceRect({ x0: 100, y0: 50, x1: 200, y1: 150 }, shown, source)).toEqual({
			x: 400,
			y: 200,
			width: 400,
			height: 400
		});
	});

	it('takes a drag from any corner', () => {
		const forward = sourceRect({ x0: 10, y0: 10, x1: 60, y1: 40 }, shown, source);
		const backward = sourceRect({ x0: 60, y0: 40, x1: 10, y1: 10 }, shown, source);
		expect(backward).toEqual(forward);
	});

	it('stops at the edges of the preview', () => {
		expect(sourceRect({ x0: 900, y0: 500, x1: 2000, y1: 2000 }, shown, source)).toEqual({
			x: 3600,
			y: 2000,
			width: 240,
			height: 160
		});
	});

	it('treats a click as no selection', () => {
		expect(sourceRect({ x0: 100, y0: 100, x1: 102, y1: 140 }, shown, source)).toBeNull();
	});
});

describe('capturing a region', () => {
	it('hides the window for the capture and brings it back', async () => {
		tauri.invoke.mockImplementation(async () => {
			tauri.calls.push('capture');
			return { dataUrl: 'data:x', width: 1, height: 1 };
		});
		await startRegionCapture();
		expect(tauri.calls).toEqual(['hide', 'capture', 'show', 'focus']);
	});

	it('brings the window back when the capture fails', async () => {
		tauri.invoke.mockRejectedValue('no portal');
		await expect(startRegionCapture()).rejects.toBe('no portal');
		expect(tauri.calls).toContain('show');
	});

	it('discards the held frame when cancelled', async () => {
		tauri.invoke.mockResolvedValue(null);
		expect(await finishRegionCapture(null)).toBeNull();
		expect(tauri.invoke).toHaveBeenCalledWith('capture_region_finish', { rect: null });
	});
});
