import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import Modal from './Modal.svelte';

// Modal's initial-focus effect runs after a tick (a microtask past the
// effect flush), so tests wait a macrotask before asserting focus.
function settleFocus() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

const twoButtons = createRawSnippet(() => ({
	render: () =>
		'<div>' +
		'<button data-testid="first">First</button>' +
		'<button data-testid="second">Second</button>' +
		'</div>'
}));

describe('Modal focus management', () => {
	it('moves focus to the first focusable element on open', async () => {
		render(Modal, { open: true, children: twoButtons });
		await settleFocus();
		expect(document.activeElement).toBe(screen.getByTestId('first'));
	});

	it('prefers an [autofocus] element over the first focusable', async () => {
		const withAutofocus = createRawSnippet(() => ({
			render: () =>
				'<div>' +
				'<button data-testid="skip">Skip</button>' +
				'<button data-testid="target" autofocus>Target</button>' +
				'</div>'
		}));
		render(Modal, { open: true, children: withAutofocus });
		await settleFocus();
		expect(document.activeElement).toBe(screen.getByTestId('target'));
	});

	it('falls back to the dialog element when nothing is focusable', async () => {
		const textOnly = createRawSnippet(() => ({
			render: () => '<p>Nothing to focus here</p>'
		}));
		render(Modal, { open: true, children: textOnly });
		await settleFocus();
		expect(document.activeElement).toBe(screen.getByRole('dialog'));
	});

	it('leaves focus alone when a child already self-focused', async () => {
		const withInput = createRawSnippet(() => ({
			render: () =>
				'<div>' + '<button data-testid="a">A</button>' + '<input data-testid="self" />' + '</div>'
		}));
		render(Modal, { open: true, children: withInput });
		// Simulate a child that self-focuses during mount (UserQuestionModal's
		// textarea): focus lands before Modal's after-a-tick check runs.
		screen.getByTestId('self').focus();
		await settleFocus();
		expect(document.activeElement).toBe(screen.getByTestId('self'));
	});

	it('Tab from the last focusable wraps to the first', async () => {
		render(Modal, { open: true, children: twoButtons });
		await settleFocus();
		const second = screen.getByTestId('second');
		second.focus();
		await fireEvent.keyDown(second, { key: 'Tab' });
		expect(document.activeElement).toBe(screen.getByTestId('first'));
	});

	it('Shift+Tab from the first focusable wraps to the last', async () => {
		render(Modal, { open: true, children: twoButtons });
		await settleFocus();
		const first = screen.getByTestId('first');
		first.focus();
		await fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
		expect(document.activeElement).toBe(screen.getByTestId('second'));
	});

	it('restores focus to the opener on close', async () => {
		const trigger = document.createElement('button');
		document.body.appendChild(trigger);
		trigger.focus();

		const { rerender } = render(Modal, { open: false, children: twoButtons });
		await rerender({ open: true });
		await settleFocus();
		expect(document.activeElement).not.toBe(trigger);

		await rerender({ open: false });
		expect(document.activeElement).toBe(trigger);
		trigger.remove();
	});
});
