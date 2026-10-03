import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import UserQuestionModal from './UserQuestionModal.svelte';
import { askUserQuestion, cancelUserQuestion } from '$lib/stores/userQuestion.svelte';

afterEach(() => {
	cancelUserQuestion();
});

async function ask(req: { question: string; body?: string }) {
	render(UserQuestionModal);
	askUserQuestion({ ...req, options: [{ label: 'Approve' }] }).catch(() => {});
	await tick();
}

describe('UserQuestionModal', () => {
	it('puts only the question in the heading, and the body as markdown below it', async () => {
		await ask({
			question: "Here's the plan outline — 2 phase(s).",
			body: '**Phase 01 — One**\n\nfirst\n\n**Phase 02 — Two**\n\nsecond'
		});
		const heading = screen.getByRole('heading', { level: 2 });
		expect(heading.textContent).toBe("Here's the plan outline — 2 phase(s).");
		const strong = screen.getByText('Phase 01 — One');
		expect(strong.tagName).toBe('STRONG');
		expect(screen.getByText('second')).toBeTruthy();
	});

	it('renders no body when there is none', async () => {
		await ask({ question: 'Pick one' });
		expect(document.querySelector('.qbody-text')).toBeNull();
	});

	it('does not run a script in the body', async () => {
		await ask({ question: 'Pick one', body: 'hi <script>window.__pwned = 1</script>' });
		expect(document.querySelector('.qbody-text script')).toBeNull();
		expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
	});
});
