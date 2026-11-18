import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import PreviewToolbar from './PreviewToolbar.svelte';

function setup(width: 'phone' | 'tablet' | 'full' = 'full') {
	const props = {
		path: 'mockup/index.html',
		url: 'http://127.0.0.1:1/t/mockup/index.html',
		width,
		onReload: vi.fn(),
		onWidth: vi.fn(),
		onOpenInBrowser: vi.fn()
	};
	render(PreviewToolbar, { props });
	return props;
}

describe('PreviewToolbar', () => {
	it('shows the file and marks the current width', () => {
		setup('tablet');
		expect(screen.getByText('mockup/index.html')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Tablet' }).getAttribute('aria-pressed')).toBe(
			'true'
		);
		expect(screen.getByRole('button', { name: 'Phone' }).getAttribute('aria-pressed')).toBe(
			'false'
		);
	});

	it('hands each button to its handler', async () => {
		const p = setup();
		await fireEvent.click(screen.getByRole('button', { name: 'Phone' }));
		expect(p.onWidth).toHaveBeenCalledWith('phone');
		await fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
		expect(p.onReload).toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
		expect(p.onOpenInBrowser).toHaveBeenCalled();
	});
});
