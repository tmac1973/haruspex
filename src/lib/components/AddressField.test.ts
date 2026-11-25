import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import AddressField from './AddressField.svelte';

const contacts = [
	{ name: 'Sam Lee', email: 'sam@example.com', accountLabel: 'G' },
	{ name: 'Samantha Ortiz', email: 'sortiz@example.com', accountLabel: 'G' }
];

function setup(value = '') {
	render(AddressField, { label: 'To', value, contacts });
	return screen.getByRole('combobox', { name: 'To' }) as HTMLInputElement;
}

async function type(input: HTMLInputElement, text: string) {
	await fireEvent.focus(input);
	await fireEvent.input(input, { target: { value: text } });
}

describe('AddressField', () => {
	it('suggests contacts for the entry being typed', async () => {
		const input = setup();
		await type(input, 'bob@x.co, sam');
		const options = screen.getAllByRole('option');
		expect(options.map((o) => o.textContent)).toEqual([
			'Sam Lee sam@example.com',
			'Samantha Ortiz sortiz@example.com'
		]);
		expect(input.getAttribute('aria-expanded')).toBe('true');
	});

	it('picks with the arrow keys and Enter, ready for the next address', async () => {
		const input = setup();
		await type(input, 'sam');
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(input.value).toBe('Samantha Ortiz <sortiz@example.com>, ');
		expect(screen.queryAllByRole('option')).toHaveLength(0);
	});

	it('picks with a click', async () => {
		const input = setup();
		await type(input, 'sa');
		await fireEvent.mouseDown(screen.getAllByRole('option')[0]);
		expect(input.value).toBe('Sam Lee <sam@example.com>, ');
	});

	it('closes the list on Esc without letting the key reach the dialog', async () => {
		const input = setup();
		await type(input, 'sam');
		let reached = false;
		window.addEventListener('keydown', () => (reached = true), { once: true });
		await fireEvent.keyDown(input, { key: 'Escape' });
		expect(screen.queryAllByRole('option')).toHaveLength(0);
		expect(reached).toBe(false);
	});

	it('suggests nothing with no contacts, and Enter is left alone', async () => {
		render(AddressField, { label: 'Cc', value: '', contacts: [] });
		const input = screen.getByRole('combobox', { name: 'Cc' }) as HTMLInputElement;
		await type(input, 'sam');
		expect(screen.queryAllByRole('option')).toHaveLength(0);
		expect(input.getAttribute('aria-expanded')).toBe('false');
	});
});
