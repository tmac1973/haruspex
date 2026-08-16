import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import Tooltip from './Tooltip.svelte';

const HELP = 'A cheap lint or typecheck the runner executes before every commit.';

describe('Tooltip', () => {
	it('is hidden until asked for', () => {
		render(Tooltip, { text: HELP });
		expect(screen.queryByRole('tooltip')).toBeNull();
		// The affordance itself is always there — that visible hint that help
		// exists is the reason this replaces the native `title` attribute.
		expect(screen.getByRole('button', { name: 'More information' })).toBeTruthy();
	});

	it('opens on hover and closes on leave', async () => {
		render(Tooltip, { text: HELP });
		await fireEvent.mouseEnter(screen.getByTestId('tooltip-wrap'));
		expect(screen.getByRole('tooltip').textContent).toBe(HELP);
		await fireEvent.mouseLeave(screen.getByTestId('tooltip-wrap'));
		expect(screen.queryByRole('tooltip')).toBeNull();
	});

	it('opens on keyboard focus', async () => {
		// Hover-only help is unreachable by keyboard, which is most of why the
		// native title attribute was not good enough either.
		render(Tooltip, { text: HELP });
		await fireEvent.focus(screen.getByRole('button', { name: 'More information' }));
		expect(screen.getByRole('tooltip')).toBeTruthy();
	});

	it('closes on Escape and keeps focus on the trigger', async () => {
		render(Tooltip, { text: HELP });
		const trigger = screen.getByRole('button', { name: 'More information' });
		trigger.focus();
		await fireEvent.focus(trigger);
		expect(screen.getByRole('tooltip')).toBeTruthy();

		await fireEvent.keyDown(trigger, { key: 'Escape' });
		expect(screen.queryByRole('tooltip')).toBeNull();
		await new Promise((r) => setTimeout(r, 0));
		// Focus must not be lost to the page — a dismissed tooltip should leave
		// the user exactly where they were in the form.
		expect(document.activeElement).toBe(trigger);
	});

	it('ignores keys other than Escape', async () => {
		render(Tooltip, { text: HELP });
		const trigger = screen.getByRole('button', { name: 'More information' });
		await fireEvent.focus(trigger);
		await fireEvent.keyDown(trigger, { key: 'a' });
		expect(screen.getByRole('tooltip')).toBeTruthy();
	});

	it('wires aria-describedby only while open', async () => {
		render(Tooltip, { text: HELP });
		const trigger = screen.getByRole('button', { name: 'More information' });
		expect(trigger.getAttribute('aria-describedby')).toBeNull();

		await fireEvent.click(trigger);
		const tip = screen.getByRole('tooltip');
		expect(trigger.getAttribute('aria-describedby')).toBe(tip.id);
		expect(trigger.getAttribute('aria-expanded')).toBe('true');
	});

	it('takes an explicit accessible name', async () => {
		render(Tooltip, { text: HELP, label: 'About phase verification' });
		expect(screen.getByRole('button', { name: 'About phase verification' })).toBeTruthy();
	});

	/**
	 * The trap the coding editor already documents for its `<details>` block:
	 * a click inside a `<label>` forwards activation to the label's control.
	 * Left unhandled, every tooltip toggle would yank focus into the field's
	 * input — and these tooltips live inside labels.
	 */
	it('does not focus the field when toggled inside a label', async () => {
		render(Tooltip, { text: HELP });
		const wrap = screen.getByTestId('tooltip-wrap');

		// Relocate the rendered tooltip into a real label/input pair. Moving
		// the node keeps its listeners, so this exercises the same handlers the
		// editors will run inside their own field labels.
		const label = document.createElement('label');
		const input = document.createElement('input');
		label.appendChild(input);
		label.appendChild(wrap);
		document.body.appendChild(label);

		const trigger = screen.getByRole('button', { name: 'More information' });
		await fireEvent.click(trigger);

		expect(screen.getByRole('tooltip')).toBeTruthy();
		expect(document.activeElement).not.toBe(input);
		label.remove();
	});
});
