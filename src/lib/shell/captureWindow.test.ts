import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import {
	CAPTURE_PROMPT,
	captureMessage,
	captureWindowImage,
	windowLabel,
	windowsToPick
} from './captureWindow';

beforeEach(() => tauri.invoke.mockReset());

describe('capturing a window for the Shell assistant', () => {
	it('asks the platform picker when there is no list to choose from', async () => {
		tauri.invoke.mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,AA', width: 1, height: 1 });
		expect(await captureWindowImage(null)).toBe('data:image/jpeg;base64,AA');
		expect(tauri.invoke).toHaveBeenCalledWith('capture_screen', { target: 'window' });
	});

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
