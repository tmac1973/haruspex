import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import Toasts from './Toasts.svelte';
import { showToast, dismissToast, getToasts } from '$lib/stores/toasts.svelte';

describe('Toasts host', () => {
	afterEach(() => {
		// The store is module-level; drain it so toasts don't leak between
		// tests (dismissing also clears the pending auto-dismiss timers).
		while (getToasts().length > 0) dismissToast(getToasts()[0].id);
	});

	it('always renders the polite live-region container', () => {
		const { container } = render(Toasts);
		expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
	});

	it('renders a shown toast and dismisses it via the × button', async () => {
		render(Toasts);
		showToast('File saved');
		await tick();

		expect(screen.getByText('File saved')).toBeTruthy();
		await fireEvent.click(screen.getByLabelText('Dismiss'));
		expect(screen.queryByText('File saved')).toBeNull();
	});

	it('error toasts get role="alert"; info toasts do not', async () => {
		render(Toasts);
		showToast('all good');
		showToast('it broke', { kind: 'error' });
		await tick();

		const alerts = screen.getAllByRole('alert');
		expect(alerts).toHaveLength(1);
		expect(alerts[0].textContent).toContain('it broke');
	});

	it('the action button runs onAction and dismisses the toast', async () => {
		const onAction = vi.fn();
		render(Toasts);
		showToast('Send failed', { kind: 'error', actionLabel: 'Retry', onAction });
		await tick();

		await fireEvent.click(screen.getByText('Retry'));
		expect(onAction).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('Send failed')).toBeNull();
	});
});
