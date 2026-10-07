import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import UserQuestionModal from './UserQuestionModal.svelte';
import { askUserQuestion, cancelUserQuestion } from '#lib/stores/userQuestion.svelte.ts';

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

describe('UserQuestionModal multi-select', () => {
	async function askMany() {
		render(UserQuestionModal);
		const answer = askUserQuestion({
			question: 'Which features?',
			options: [{ label: 'Saves' }, { label: 'Leaderboard' }, { label: 'Sound' }],
			allowMultiple: true
		});
		await tick();
		// Wrapped: returned bare from an async function, the promise would be
		// adopted and the caller would wait for the answer itself.
		return { answer };
	}

	it('ticks several options and submits them all', async () => {
		const { answer } = await askMany();
		await fireEvent.click(screen.getByText('Saves'));
		await fireEvent.click(screen.getByText('Sound'));
		await fireEvent.click(screen.getByText('Submit'));
		await expect(answer).resolves.toEqual({ kind: 'selected', labels: ['Saves', 'Sound'] });
	});

	it('unticks an option clicked twice', async () => {
		const { answer } = await askMany();
		await fireEvent.click(screen.getByText('Saves'));
		await fireEvent.click(screen.getByText('Leaderboard'));
		await fireEvent.click(screen.getByText('Saves'));
		await fireEvent.click(screen.getByText('Submit'));
		await expect(answer).resolves.toEqual({ kind: 'selected', labels: ['Leaderboard'] });
	});

	it('keeps the ticks when the user adds something of their own', async () => {
		const { answer } = await askMany();
		await fireEvent.click(screen.getByText('Saves'));
		await fireEvent.click(screen.getByText('Add something else'));
		const box = screen.getByPlaceholderText('Type your answer…') as HTMLTextAreaElement;
		await fireEvent.input(box, { target: { value: 'a pause menu' } });
		expect(screen.getByText('Saves').closest('button')?.getAttribute('aria-pressed')).toBe('true');
		await fireEvent.click(screen.getByText('Submit'));
		await expect(answer).resolves.toEqual({
			kind: 'selected',
			labels: ['Saves'],
			note: 'a pause menu'
		});
	});

	it('sends typed text alone as a custom answer when nothing is ticked', async () => {
		const { answer } = await askMany();
		await fireEvent.click(screen.getByText('Add something else'));
		await fireEvent.input(screen.getByPlaceholderText('Type your answer…'), {
			target: { value: 'none of these' }
		});
		await fireEvent.click(screen.getByText('Submit'));
		await expect(answer).resolves.toEqual({ kind: 'freeText', text: 'none of these' });
	});

	it('still clears the pick when a single-choice question gets a typed answer', async () => {
		render(UserQuestionModal);
		const answer = askUserQuestion({
			question: 'One?',
			options: [{ label: 'A' }, { label: 'B' }]
		});
		await tick();
		await fireEvent.click(screen.getByText('A'));
		await fireEvent.click(screen.getByText('Write your own answer'));
		await fireEvent.input(screen.getByPlaceholderText('Type your answer…'), {
			target: { value: 'C' }
		});
		await fireEvent.click(screen.getByText('Submit'));
		await expect(answer).resolves.toEqual({ kind: 'freeText', text: 'C' });
	});
});
