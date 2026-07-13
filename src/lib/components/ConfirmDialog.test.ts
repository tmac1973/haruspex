import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ConfirmDialog from './ConfirmDialog.svelte';

function settleFocus() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function renderDialog(overrides: Record<string, unknown> = {}) {
	const onconfirm = vi.fn();
	const oncancel = vi.fn();
	const utils = render(ConfirmDialog, {
		open: true,
		title: 'Delete conversation?',
		message: 'This cannot be undone.',
		onconfirm,
		oncancel,
		...overrides
	});
	return { onconfirm, oncancel, ...utils };
}

describe('ConfirmDialog', () => {
	it('renders title, message, and default button labels', () => {
		renderDialog();
		expect(screen.getByText('Delete conversation?')).toBeTruthy();
		expect(screen.getByText('This cannot be undone.')).toBeTruthy();
		expect(screen.getByText('Delete')).toBeTruthy();
		expect(screen.getByText('Cancel')).toBeTruthy();
	});

	it('gives Cancel initial focus', async () => {
		renderDialog();
		await settleFocus();
		const active = document.activeElement as HTMLElement;
		expect(active.tagName).toBe('BUTTON');
		expect(active.textContent).toContain('Cancel');
	});

	it('fires onconfirm from the confirm button only', async () => {
		const { onconfirm, oncancel } = renderDialog();
		await fireEvent.click(screen.getByText('Delete'));
		expect(onconfirm).toHaveBeenCalledTimes(1);
		expect(oncancel).not.toHaveBeenCalled();
	});

	it('fires oncancel from the cancel button only', async () => {
		const { onconfirm, oncancel } = renderDialog();
		await fireEvent.click(screen.getByText('Cancel'));
		expect(oncancel).toHaveBeenCalledTimes(1);
		expect(onconfirm).not.toHaveBeenCalled();
	});

	it('Escape fires oncancel', async () => {
		const { onconfirm, oncancel } = renderDialog();
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(oncancel).toHaveBeenCalledTimes(1);
		expect(onconfirm).not.toHaveBeenCalled();
	});

	it('backdrop mousedown fires oncancel', async () => {
		const { oncancel, container } = renderDialog();
		const backdrop = container.querySelector('.modal-backdrop') as HTMLElement;
		await fireEvent.mouseDown(backdrop);
		expect(oncancel).toHaveBeenCalledTimes(1);
	});

	it('honors custom labels', () => {
		renderDialog({ confirmLabel: 'Overwrite', cancelLabel: 'Keep mine' });
		expect(screen.getByText('Overwrite')).toBeTruthy();
		expect(screen.getByText('Keep mine')).toBeTruthy();
	});

	it('uses the danger variant when destructive, default otherwise', () => {
		const first = renderDialog();
		expect(screen.getByText('Delete').closest('button')!.className).toContain('danger');
		first.unmount();

		renderDialog({ destructive: false, confirmLabel: 'Proceed' });
		const confirm = screen.getByText('Proceed').closest('button')!;
		expect(confirm.className).not.toContain('danger');
	});
});
