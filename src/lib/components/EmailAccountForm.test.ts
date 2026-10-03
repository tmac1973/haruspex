import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';

const state = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));

import EmailAccountForm from './EmailAccountForm.svelte';
import type { EmailAccount } from '$lib/stores/settings';

function account(over: Partial<EmailAccount> = {}): EmailAccount {
	return {
		id: 'a1',
		label: 'Work',
		enabled: true,
		sendEnabled: false,
		provider: 'custom',
		emailAddress: 'me@example.com',
		password: '',
		passwordRef: 'email:a1',
		imapHost: 'imap.example.com',
		imapPort: 993,
		imapTls: 'implicit',
		smtpHost: '',
		smtpPort: 0,
		smtpTls: 'implicit',
		...over
	};
}

const commands = () => state.invoke.mock.calls.map((c) => c[0]);

function renderForm(acc = account()) {
	const onChange = vi.fn();
	render(EmailAccountForm, { account: acc, presets: [], onChange, onDelete: vi.fn() });
	const field = screen.getByLabelText('App password') as HTMLInputElement;
	return { onChange, field };
}

beforeEach(() => {
	state.invoke.mockReset().mockImplementation(async (cmd: string) => {
		if (cmd === 'secret_available') return true;
		return null;
	});
});

describe('EmailAccountForm password', () => {
	it('shows where the password is kept, never the password', () => {
		const { field } = renderForm();
		expect(field.value).toBe('');
		expect(field.placeholder).toBe('Saved in the system keychain');
	});

	it('touches no secret while typing, only on Save', async () => {
		const { field, onChange } = renderForm();
		await fireEvent.input(field, { target: { value: 'new-pw' } });
		await fireEvent.blur(field);
		expect(commands()).not.toContain('secret_set');

		await fireEvent.click(screen.getByText('Save password'));
		await waitFor(() => expect(onChange).toHaveBeenCalled());
		// Tested with the new password before it is kept.
		expect(commands().slice(0, 1)).toEqual(['email_test_connection']);
		expect(state.invoke.mock.calls[0][1].account).toMatchObject({ password: 'new-pw' });
		expect(state.invoke).toHaveBeenCalledWith('secret_set', { key: 'email:a1', value: 'new-pw' });
		expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({
			password: '',
			passwordRef: 'email:a1'
		});
		expect(field.value).toBe('');
	});

	it('keeps nothing when the test fails', async () => {
		state.invoke.mockImplementation(async (cmd: string) => {
			if (cmd === 'email_test_connection') throw 'LOGIN rejected';
			return true;
		});
		const { field } = renderForm();
		await fireEvent.input(field, { target: { value: 'wrong' } });
		await fireEvent.click(screen.getByText('Save password'));
		await screen.findByText(/LOGIN rejected/);
		expect(commands()).not.toContain('secret_set');
	});

	it('tests with the kept password when the field is empty', async () => {
		renderForm();
		await fireEvent.click(screen.getByText('Test connection'));
		await waitFor(() => expect(commands()).toContain('email_test_connection'));
		const sent = state.invoke.mock.calls.find((c) => c[0] === 'email_test_connection')?.[1];
		expect(sent.account).toMatchObject({ password: '', passwordRef: 'email:a1' });
	});
});
