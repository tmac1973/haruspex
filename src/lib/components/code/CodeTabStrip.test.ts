import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const store = vi.hoisted(() => ({
	closeSession: vi.fn(),
	setActiveSession: vi.fn(),
	getActiveSessionId: vi.fn(() => 's1'),
	getOpenSessions: vi.fn(() => [
		{ id: 's1', title: 'Idle one', root: '/p', status: 'idle', background: [] },
		{ id: 's2', title: 'Busy one', root: '/p', status: 'running', background: [] },
		{ id: 's3', title: 'Waiting one', root: '/p', status: 'queued', background: [] },
		{
			id: 's4',
			title: 'Shell one',
			root: '/p',
			status: 'waiting-shell',
			background: [{ id: 'bg', running: true }]
		}
	])
}));
vi.mock('#lib/stores/code.svelte.ts', () => store);

import CodeTabStrip from './CodeTabStrip.svelte';

describe('CodeTabStrip', () => {
	it('shows a status dot for each session that is doing something', () => {
		const { container } = render(CodeTabStrip, { onNew: vi.fn() });
		const dots = [...container.querySelectorAll('.dot')].map((d) => d.getAttribute('data-status'));
		expect(dots).toEqual(['running', 'queued', 'waiting-shell']);
		expect(screen.getByTitle('Queued behind another turn')).toBeTruthy();
		expect(screen.getByTitle('Waiting for a command in the Shell tab')).toBeTruthy();
		const idle = screen.getByRole('tab', { name: /Idle one/ });
		expect(idle.querySelector('.dot')).toBeNull();
		expect(idle.getAttribute('aria-selected')).toBe('true');
	});

	it('asks before closing a session whose background processes are running', async () => {
		render(CodeTabStrip, { onNew: vi.fn() });
		screen.getByRole('button', { name: 'Close Shell one' }).click();
		expect(await screen.findByText('Close session?')).toBeTruthy();
		expect(store.closeSession).not.toHaveBeenCalled();
		screen.getByRole('button', { name: 'Close Idle one' }).click();
		expect(store.closeSession).toHaveBeenCalledWith('s1');
	});
});
