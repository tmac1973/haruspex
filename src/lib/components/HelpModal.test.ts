import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import HelpModal from './HelpModal.svelte';

describe('HelpModal', () => {
	it('renders the shortcuts dialog when open', () => {
		render(HelpModal, { open: true, onclose: vi.fn() });
		expect(screen.getByRole('dialog')).toBeTruthy();
		expect(screen.getByText('Keyboard shortcuts')).toBeTruthy();
		// A known shortcut row is present
		expect(screen.getByText('Show this shortcuts help')).toBeTruthy();
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
});
