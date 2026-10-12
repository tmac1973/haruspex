import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), calls: [] as string[] }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/window', () => ({
	getCurrentWindow: () => ({
		hide: async () => void tauri.calls.push('hide'),
		show: async () => void tauri.calls.push('show'),
		setFocus: async () => void tauri.calls.push('focus')
	})
}));

import {
	CAPTURE_PROMPT,
	captureMessage,
	captureWindowImage,
	clickWindow,
	windowLabel,
	windowsToPick
} from './captureWindow';

beforeEach(() => {
	tauri.invoke.mockReset();
	tauri.calls.length = 0;
});

describe('clicking a window where there is no list (Linux)', () => {
	it('hands back the window clicked, with Haruspex hidden meanwhile', async () => {
		tauri.invoke.mockImplementation(async (cmd: string) => {
			tauri.calls.push(cmd);
			return { kind: 'captured', capture: { dataUrl: 'data:w', width: 1, height: 1 } };
		});
		expect(await clickWindow()).toEqual({ kind: 'captured', dataUrl: 'data:w' });
		expect(tauri.calls).toEqual(['hide', 'capture_window_click', 'show', 'focus']);
	});

	it('reports Escape as cancelled, with nothing captured', async () => {
		tauri.invoke.mockResolvedValue({ kind: 'cancelled' });
		expect(await clickWindow()).toEqual({ kind: 'cancelled' });
		expect(tauri.calls).toEqual(['hide', 'show', 'focus']);
	});

	it('takes the screen for a region instead, without showing Haruspex in between', async () => {
		const preview = { dataUrl: 'data:s', width: 2, height: 2 };
		tauri.invoke.mockImplementation(async (cmd: string) => {
			tauri.calls.push(cmd);
			return cmd === 'capture_window_click' ? { kind: 'unavailable' } : preview;
		});
		expect(await clickWindow()).toEqual({ kind: 'region', preview });
		expect(tauri.calls).toEqual([
			'hide',
			'capture_window_click',
			'capture_region_start',
			'show',
			'focus'
		]);
	});
});

describe('capturing a window for the Shell assistant', () => {
	it('captures the window picked from the list by its id', async () => {
		tauri.invoke.mockResolvedValue({ dataUrl: 'data:x', width: 1, height: 1 });
		await captureWindowImage(42);
		expect(tauri.invoke).toHaveBeenCalledWith('capture_window', { id: 42 });
	});

	it('lists the windows through Rust', async () => {
		tauri.invoke.mockResolvedValue([]);
		expect(await windowsToPick()).toEqual([]);
		expect(tauri.invoke).toHaveBeenCalledWith('list_capture_windows');
	});

	it('sends what was typed, else a default ask', () => {
		expect(captureMessage('  why is the HUD cut off?  ')).toBe('why is the HUD cut off?');
		expect(captureMessage('   ')).toBe(CAPTURE_PROMPT);
	});

	it('names a window by its title and app, without saying the app twice', () => {
		expect(windowLabel({ id: 1, title: 'Dark Times', app: 'darktimes' })).toBe(
			'Dark Times — darktimes'
		);
		expect(windowLabel({ id: 2, title: 'notes.txt - Notepad', app: 'Notepad' })).toBe(
			'notes.txt - Notepad'
		);
		expect(windowLabel({ id: 3, title: '', app: 'Finder' })).toBe('Finder');
	});
});
