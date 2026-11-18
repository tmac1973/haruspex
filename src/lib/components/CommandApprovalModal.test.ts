import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import CommandApprovalModal from './CommandApprovalModal.svelte';
import { askCommandApproval } from '#lib/stores/codeCommandApproval.svelte.ts';

describe('CommandApprovalModal', () => {
	it('names who is asking, and shows the next prompt once one is answered', async () => {
		render(CommandApprovalModal);
		const first = askCommandApproval({ command: 'rm -rf a', reasons: [], requester: 'Code · A' });
		const second = askCommandApproval({ command: 'rm -rf b', reasons: [], requester: 'Shell 2' });
		await screen.findByText('rm -rf a');
		const who = screen.getByTestId('command-approval-requester');
		expect(who.textContent).toContain('Code · A');
		expect(who.textContent).toContain('1 more waiting');

		await fireEvent.click(screen.getByText('Allow once'));
		expect(await first).toBe('allow_once');
		await screen.findByText('rm -rf b');
		expect(screen.getByTestId('command-approval-requester').textContent).toContain('Shell 2');
		expect(screen.getByTestId('command-approval-requester').textContent).not.toContain('waiting');

		await fireEvent.click(screen.getByText('Deny'));
		expect(await second).toBe('deny');
	});

	it('says which computer asked, only for another computer', async () => {
		render(CommandApprovalModal);
		const here = askCommandApproval({ command: 'make', reasons: [] });
		await screen.findByText('make');
		expect(screen.queryByTestId('prompt-origin')).toBeNull();
		await fireEvent.click(screen.getByText('Deny'));
		await here;

		const there = askCommandApproval({
			command: 'make test',
			reasons: [],
			origin: { peerId: 'desk', name: 'desk-pc' }
		});
		await screen.findByText('make test');
		expect(screen.getByTestId('prompt-origin').textContent?.trim()).toBe('On desk-pc');
		await fireEvent.click(screen.getByText('Deny'));
		await there;
	});
});
