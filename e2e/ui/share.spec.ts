import { test, expect, useScenario } from './fixtures';
import type { Page } from '@playwright/test';

/** An account that may send, so Email is offered. */
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
			}
		}
	}
});

/** The arguments of each call to `cmd` so far. */
function callsTo(app: Page, cmd: string) {
	return app.evaluate(
		(cmd) => (window.__e2e?.calls ?? []).filter((c) => c.cmd === cmd).map((c) => c.args),
		cmd
	);
}

async function answer(app: Page) {
	await useScenario('chat-hello');
	const input = app.getByPlaceholder(/Type a message/);
	await input.fill('hello there');
	await input.press('Enter');
	await expect(app.getByText('Hello from the fake model.', { exact: false })).toBeVisible();
}

test('an answer and its conversation go to a print window', async ({ app }) => {
	await answer(app);

	await app.getByRole('button', { name: 'Print this answer' }).click();
	await expect.poll(() => callsTo(app, 'print_open')).toHaveLength(1);
	const [one] = (await callsTo(app, 'print_open')) as { doc: { html: string } }[];
	expect(one.doc.html).toContain('Hello from the fake model.');
	expect(one.doc.html).not.toContain('hello there');

	await app.getByRole('button', { name: 'Print conversation' }).click();
	await expect.poll(() => callsTo(app, 'print_open')).toHaveLength(2);
	const [, all] = (await callsTo(app, 'print_open')) as { doc: { html: string } }[];
	expect(all.doc.html).toContain('hello there');
	expect(all.doc.html).toContain('Hello from the fake model.');
});

test('Email opens a new message to address, with no Note', async ({ app }) => {
	await answer(app);

	await app.getByRole('button', { name: 'Email this answer' }).click();
	const dialog = app.getByRole('dialog');
	await expect(dialog.getByText('Review email')).toBeVisible();
	await expect(dialog.getByRole('textbox', { name: 'To', exact: true })).toBeFocused();
	await expect(dialog.getByLabel('Message')).toHaveValue(/Hello from the fake model\./);
	await expect(dialog.getByLabel('Note', { exact: true })).toHaveCount(0);
	await app.getByRole('button', { name: 'Discard' }).click();

	await app.getByRole('button', { name: 'Email conversation' }).click();
	await expect(dialog.getByLabel('Message')).toHaveValue(/^You:\nhello there/);
	await app.getByRole('button', { name: 'Discard' }).click();
	expect(await callsTo(app, 'email_send')).toHaveLength(0);
});

test('a notebook prints, and its menu offers Email', async ({ app }) => {
	await app.getByRole('tab', { name: 'Notebooks' }).click();
	await app.getByRole('button', { name: '+ New' }).click();
	const name = app.getByLabel('New notebook title');
	await name.fill('Trip');
	await name.press('Enter');
	await expect(app.getByLabel('Notebook title')).toHaveValue('Trip');

	await app.getByRole('button', { name: 'Notebook options' }).click();
	await expect(app.getByRole('menuitem', { name: 'Email…' })).toBeVisible();
	await app.getByRole('menuitem', { name: 'Print…' }).click();
	await expect.poll(() => callsTo(app, 'print_open')).toHaveLength(1);
	const [doc] = (await callsTo(app, 'print_open')) as { doc: { title: string; html: string } }[];
	expect(doc.doc.title).toBe('Trip');
	expect(doc.doc.html).toContain('<h1>Trip</h1>');
});
