import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import CommandApprovalModal from './CommandApprovalModal.svelte';
import { askCommandApproval } from '#lib/stores/codeCommandApproval.svelte.ts';

describe('CommandApprovalModal', () => {
	it('names who is asking, and shows the next prompt once one is answered', async () => {
		render(CommandApprovalModal);
		const first = askCommandApproval({ command: 'rm -rf a', reasons: [], requester: 'Code · A' });
		const second = askCommandApproval({ command: 'rm -rf b', reasons: [], requester: 'Shell 2' });
		expect(await screen.findByText('rm -rf a')).toBeTruthy();
		const who = screen.getByTestId('command-approval-requester');
		expect(who.textContent).toContain('Code · A');
		expect(who.textContent).toContain('1 more waiting');

		await fireEvent.click(screen.getByText('Allow once'));
		expect(await first).toBe('allow_once');
		expect(await screen.findByText('rm -rf b')).toBeTruthy();
		expect(screen.getByTestId('command-approval-requester').textContent).toContain('Shell 2');
		expect(screen.getByTestId('command-approval-requester').textContent).not.toContain('waiting');

		await fireEvent.click(screen.getByText('Deny'));
		expect(await second).toBe('deny');
	});
});
