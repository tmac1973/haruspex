import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';

import AgentsMdBadge from './AgentsMdBadge.svelte';

const agentsMd = { files: ['AGENTS.md'], text: 'x', truncated: false, totalBytes: 1 };

describe('AgentsMdBadge', () => {
	it('opens to show the repo, and stops using it on request', async () => {
		const onIgnore = vi.fn();
		render(AgentsMdBadge, { agentsMd, root: '/code/repo', onIgnore });
		expect(screen.queryByRole('dialog')).toBeNull();

		await fireEvent.click(screen.getByText('AGENTS.md'));
		expect(screen.getByText('/code/repo')).toBeTruthy();
		await fireEvent.click(screen.getByText("Stop using this repo's instructions"));
		expect(onIgnore).toHaveBeenCalledOnce();
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('closes on Escape and on a click elsewhere', async () => {
		render(AgentsMdBadge, { agentsMd, root: '/code/repo', onIgnore: vi.fn() });
		await fireEvent.click(screen.getByText('AGENTS.md'));
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.queryByRole('dialog')).toBeNull();

		await fireEvent.click(screen.getByText('AGENTS.md'));
		await fireEvent.click(document.body);
		expect(screen.queryByRole('dialog')).toBeNull();
	});
});
