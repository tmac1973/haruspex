import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/webview', () => ({
	getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) })
}));

import { isInside, toCss } from './fileDrop';

const rect = (left: number, top: number, w: number, h: number) =>
	({ left, top, right: left + w, bottom: top + h, width: w, height: h }) as DOMRect;

describe('file drop hit-testing', () => {
	it('scales physical pixels to CSS pixels', () => {
		expect(toCss({ x: 200, y: 100 }, 2)).toEqual({ x: 100, y: 50 });
	});

	it('takes drops inside the element only', () => {
		const r = rect(10, 10, 100, 50);
		expect(isInside({ x: 50, y: 30 }, r)).toBe(true);
		expect(isInside({ x: 5, y: 30 }, r)).toBe(false);
		expect(isInside({ x: 50, y: 61 }, r)).toBe(false);
	});

	it('never takes a drop on a hidden element', () => {
		expect(isInside({ x: 0, y: 0 }, rect(0, 0, 0, 0))).toBe(false);
	});
});
