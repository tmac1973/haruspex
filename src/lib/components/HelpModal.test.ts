import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({}, async () => undefined)
);

import HelpModal from './HelpModal.svelte';
import { GUIDE_URL } from '#lib/guide/prompt.ts';

describe('HelpModal', () => {
	it('renders the shortcuts dialog when open', () => {
		render(HelpModal, { open: true, onclose: vi.fn() });
		screen.getByRole('dialog');
		screen.getByText('Keyboard shortcuts');
		// A known shortcut row is present
		screen.getByText('Show this shortcuts help');
	});

	it('renders nothing when closed', () => {
		render(HelpModal, { open: false, onclose: vi.fn() });
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('close button fires the onclose callback', async () => {
		const onclose = vi.fn();
		render(HelpModal, { open: true, onclose });
		await fireEvent.click(screen.getByLabelText('Close'));
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it('Escape fires the onclose callback (dismissable modal)', async () => {
		const onclose = vi.fn();
		render(HelpModal, { open: true, onclose });
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it('opens the online user guide in the browser', async () => {
		render(HelpModal, { open: true, onclose: vi.fn() });
		await fireEvent.click(screen.getByText('user guide'));
		expect(invoke).toHaveBeenCalledWith('open_url', { url: GUIDE_URL });
	});
});
