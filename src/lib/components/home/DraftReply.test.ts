import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type { EmailAccount } from '#lib/stores/settings.ts';
import type { EmailDraft } from '#lib/stores/emailReview.svelte.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

const m = vi.hoisted(() => ({
	finish: null as ((d: EmailDraft) => void) | null,
	askEmailReview: vi.fn(async () => ({ kind: 'discarded', note: '' }))
}));
vi.mock('#lib/home/draftReply.ts', () => ({
	draftReply: (opts: { onDelta: (t: string) => void }) =>
		new Promise<EmailDraft>((resolve) => {
			opts.onDelta('Thanks —');
			m.finish = resolve;
		})
}));
vi.mock('#lib/stores/emailReview.svelte.ts', () => ({ askEmailReview: m.askEmailReview }));

import DraftReply from './DraftReply.svelte';

const account = { id: 'w', label: 'Work', enabled: true, sendEnabled: true } as EmailAccount;
const draft: EmailDraft = {
	accountId: 'w',
	to: ['dana@example.com'],
	cc: [],
	subject: 'Re: Invoice',
	body: 'Thanks — paid today.',
	references: []
};

beforeEach(() => {
	m.finish = null;
	m.askEmailReview.mockClear();
});

describe('DraftReply', () => {
	it('keeps Review & send off while the draft streams, then sends the edited text to review', async () => {
		render(DraftReply, { account, messageId: '7:1', onclose: () => {} });
		const review = screen.getByRole('button', { name: 'Review & send' }) as HTMLButtonElement;
		expect(review.disabled).toBe(true);

		await fireEvent.click(screen.getByRole('button', { name: 'Draft' }));
		expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
		expect(review.disabled).toBe(true);

		m.finish!(draft);
		await vi.waitFor(() => expect(review.disabled).toBe(false));
		const box = screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement;
		await fireEvent.input(box, { target: { value: 'Paid, thanks.' } });
		await fireEvent.click(review);
		expect(m.askEmailReview).toHaveBeenCalledWith(
			expect.objectContaining({ body: 'Paid, thanks.', subject: 'Re: Invoice' }),
			expect.any(Array)
		);
	});
});
