import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ThinkingPanel from './ThinkingPanel.svelte';

describe('ThinkingPanel', () => {
	/**
	 * The regression this component exists for. Reasoning used to live inside
	 * the HTML string ChatMessage re-derives on every streaming delta, so the
	 * <details> was destroyed and rebuilt collapsed each time — and the job
	 * view's copy had a derived `open` that overrode the user on every flip.
	 * Either way the panel closed itself while you were reading it.
	 */
	it('keeps its open state when the text updates', async () => {
		const { rerender, container } = render(ThinkingPanel, {
			text: 'first thought',
			defaultOpen: false
		});
		const details = container.querySelector('details')!;
		expect(details.open).toBe(false);

		// jsdom doesn't implement the native summary-click toggle, so drive it
		// the way a browser does: flip the property, then fire `toggle`, which
		// is the event the component syncs its state from.
		details.open = true;
		await fireEvent(details, new Event('toggle'));
		expect(details.open).toBe(true);

		await rerender({ text: 'first thought\n\nsecond thought', defaultOpen: false });
		expect(container.querySelector('details')!.open).toBe(true);
		expect(container.textContent).toContain('second thought');
	});

	/**
	 * `defaultOpen` seeds and then stops mattering. Re-applying it is the same
	 * bug wearing a different hat: a parent whose expression flips mid-step
	 * would slam the panel shut again.
	 */
	it('ignores later changes to defaultOpen', async () => {
		const { rerender, container } = render(ThinkingPanel, {
			text: 'thinking',
			defaultOpen: true
		});
		expect(container.querySelector('details')!.open).toBe(true);

		await rerender({ text: 'thinking more', defaultOpen: false });
		expect(container.querySelector('details')!.open).toBe(true);
	});

	it('labels itself as live only while reasoning is in flight', () => {
		const { container } = render(ThinkingPanel, { text: 'x', live: true });
		expect(container.textContent).toContain('Thinking…');

		const done = render(ThinkingPanel, { text: 'x', live: false });
		expect(done.container.textContent).toContain('Reasoning');
	});

	it('shows the stat in the summary when given one', () => {
		render(ThinkingPanel, { text: 'x', stat: '~2m · ~1.9K tokens · 61% of generation' });
		expect(screen.getByText(/61% of generation/)).toBeTruthy();
	});
});
