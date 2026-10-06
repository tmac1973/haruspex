import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import WorkingDirButton from './WorkingDirButton.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

beforeEach(() => {
	vi.clearAllMocks();
});

function renderChip(workingDir: string | null) {
	const onClear = vi.fn();
	const { container } = render(WorkingDirButton, {
		props: { workingDir, onPick: vi.fn(), onClear }
	});
	const chip = container.querySelector<HTMLButtonElement>('.workingdir-btn')!;
	return { chip, onClear };
}

function rightClick(chip: HTMLElement): MouseEvent {
	const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
	chip.dispatchEvent(event);
	return event;
}

describe('WorkingDirButton right-click menu', () => {
	it('replaces the webview menu and opens the folder in the file manager', async () => {
		const { chip } = renderChip('/home/me/proj');
		const event = rightClick(chip);
		expect(event.defaultPrevented).toBe(true);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in file manager' }));
		expect(invoke).toHaveBeenCalledWith('open_folder', { path: '/home/me/proj' });
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('changes and clears the folder', async () => {
		const { chip, onClear } = renderChip('/home/me/proj');
		rightClick(chip);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Change folder…' }));
		expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
		rightClick(chip);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear' }));
		expect(onClear).toHaveBeenCalled();
	});

	it('offers only a folder choice when none is set', async () => {
		rightClick(renderChip(null).chip);
		expect(await screen.findByRole('menuitem', { name: 'Open in file manager' })).toHaveProperty(
			'disabled',
			true
		);
		expect(screen.getByRole('menuitem', { name: 'Choose folder…' })).toBeTruthy();
		expect(screen.queryByRole('menuitem', { name: 'Clear' })).toBeNull();
	});

	it('closes on Escape', async () => {
		rightClick(renderChip('/home/me/proj').chip);
		await screen.findByRole('menu');
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.queryByRole('menu')).toBeNull();
	});
});
