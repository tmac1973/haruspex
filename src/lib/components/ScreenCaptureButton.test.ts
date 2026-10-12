import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import ScreenCaptureButton from './ScreenCaptureButton.svelte';

beforeEach(() => {
	tauri.invoke.mockReset();
	tauri.invoke.mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,AA' });
});

describe('ScreenCaptureButton', () => {
	it('hands the whole screen to onCapture from the menu', async () => {
		const onCapture = vi.fn();
		render(ScreenCaptureButton, { onCapture });
		await fireEvent.click(screen.getByRole('button', { name: 'Attach a screenshot' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Screen' }));
		await waitFor(() => expect(onCapture).toHaveBeenCalledWith('data:image/jpeg;base64,AA'));
		// From the button, so the Linux portal skips its dialog.
		expect(tauri.invoke).toHaveBeenCalledWith('capture_screen', {
			target: 'screen',
			fromButton: true
		});
	});

	it('takes its title and label from the tab using it', () => {
		render(ScreenCaptureButton, {
			onCapture: vi.fn(),
			title: 'Send a screenshot to the assistant.',
			label: 'Send a screenshot'
		});
		const button = screen.getByRole('button', { name: 'Send a screenshot' });
		expect(button.getAttribute('title')).toBe('Send a screenshot to the assistant.');
	});

	it('stays shut while its tab is busy', () => {
		render(ScreenCaptureButton, { onCapture: vi.fn(), disabled: true });
		expect(
			(screen.getByRole('button', { name: 'Attach a screenshot' }) as HTMLButtonElement).disabled
		).toBe(true);
	});

	it('holds the button disabled until an async onCapture settles', async () => {
		let settle!: () => void;
		const onCapture = vi.fn(() => new Promise<void>((r) => (settle = r)));
		render(ScreenCaptureButton, { onCapture });
		const button = screen.getByRole('button', { name: 'Attach a screenshot' }) as HTMLButtonElement;
		await fireEvent.click(button);
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Screen' }));
		await waitFor(() => expect(onCapture).toHaveBeenCalled());
		expect(button.disabled).toBe(true);
		settle();
		await waitFor(() => expect(button.disabled).toBe(false));
	});
});
