import { test, expect, useScenario } from './fixtures';

/** An account that may send, and a Google contacts account (mocked: Sam Lee, Samantha Ortiz). */
test.use({
	settings: {
		integrations: {
			email: {
				accounts: [
					{
						id: 'a1',
						label: 'Work',
						enabled: true,
						sendEnabled: true,
						provider: 'custom',
						emailAddress: 'me@example.com',
						password: '',
						passwordRef: 'email:a1',
						imapHost: 'imap.example.com',
						imapPort: 993,
						imapTls: 'implicit',
						smtpHost: 'smtp.example.com',
						smtpPort: 465,
						smtpTls: 'implicit'
					}
				]
			},
			dav: {
				accounts: [
					{
						id: 'd1',
						kind: 'google',
						label: 'Google',
						enabled: true,
						address: '',
						username: '',
						password: '',
						passwordRef: 'dav:d1',
						calendarUrl: null,
						contactsUrl: null,
						hasCalendars: false,
						hasContacts: true
					}
				]
			}
		}
	}
});

test('To suggests contacts and adds one with their name', async ({ app }) => {
	await useScenario('chat-hello');
	const input = app.getByPlaceholder(/Type a message/);
	await input.fill('hello');
	await input.press('Enter');
	await expect(app.getByText('Hello from the fake model.', { exact: false })).toBeVisible();

	await app.getByRole('button', { name: 'Email this answer' }).click();
	const dialog = app.getByRole('dialog');
	const to = dialog.getByRole('combobox', { name: 'To' });
	await to.fill('sam');
	await expect(dialog.getByRole('option')).toHaveCount(2);
	await to.press('ArrowDown');
	await to.press('Enter');
	await expect(to).toHaveValue('Samantha Ortiz <sortiz@example.com>, ');

	// Esc closes the list, not the dialog.
	await to.pressSequentially('sa');
	await expect(dialog.getByRole('option')).toHaveCount(2);
	await to.press('Escape');
	await expect(dialog.getByRole('option')).toHaveCount(0);
	await expect(dialog.getByText('Review email')).toBeVisible();

	await to.fill('Samantha Ortiz <sortiz@example.com>');
	await dialog.getByRole('button', { name: 'Send' }).click();
	await expect
		.poll(() =>
			app.evaluate(() =>
				(window.__e2e?.calls ?? []).filter((c) => c.cmd === 'email_send').map((c) => c.args)
			)
		)
		.toEqual([
			expect.objectContaining({
				message: expect.objectContaining({ to: ['Samantha Ortiz <sortiz@example.com>'] })
			})
		]);
});
