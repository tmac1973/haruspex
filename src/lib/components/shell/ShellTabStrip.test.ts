import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';

// ShellPicker asks for the shell catalog; an empty one hides it.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
const store = vi.hoisted(() => ({
	getShellSessions: vi.fn(() =>
		Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: `Shell ${i}`, isSubmitting: false }))
	),
	getActiveShellId: vi.fn(() => 's39'),
	getActiveShellSession: vi.fn(),
	setActiveShell: vi.fn(),
	createShellSession: vi.fn(),
	closeShellSession: vi.fn()
}));
vi.mock('#lib/stores/shell.svelte.ts', () => store);
vi.mock('#lib/shell/windows.ts', () => ({ openDetachedShell: vi.fn() }));

import ShellTabStrip from './ShellTabStrip.svelte';

describe('ShellTabStrip', () => {
	it('keeps the active tab of many in view, and walks them with the arrow keys', async () => {
		const scrolled: string[] = [];
		Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
			scrolled.push(this.getAttribute('data-shell-id') ?? '');
		});

		render(ShellTabStrip);
		await tick();
		const tabs = screen.getAllByRole('tab');
		expect(tabs).toHaveLength(40);
		expect(scrolled.at(-1)).toBe('s39');
		// New shell sits outside the scrolling list, so it never scrolls away.
		const list = screen.getByRole('tablist', { name: 'Shell tabs' });
		expect(list.contains(screen.getByRole('button', { name: 'New shell' }))).toBe(false);

		tabs[0].focus();
		await fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
		expect(document.activeElement).toBe(tabs[1]);
		await fireEvent.keyDown(tabs[1], { key: 'End' });
		expect(document.activeElement).toBe(tabs[39]);
		await fireEvent.keyDown(tabs[39], { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(tabs[38]);
		await fireEvent.keyDown(tabs[38], { key: 'Home' });
		expect(document.activeElement).toBe(tabs[0]);
		await fireEvent.keyDown(tabs[0], { key: 'Enter' });
		expect(store.setActiveShell).toHaveBeenCalledWith('s0');
	});
});
