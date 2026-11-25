import { test, expect, useScenario } from './fixtures';

test.use({
	settings: {
		theme: 'dark',
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
						imapHost: 'i',
						imapPort: 993,
						imapTls: 'implicit',
						smtpHost: 's',
						smtpPort: 465,
						smtpTls: 'implicit'
					}
				]
			}
		}
	}
});

/**
 * The preview is a white page whatever the theme: in the dark theme, the
 * dialog's own text colour (light) once won on headings and paragraphs.
 */
test('the email preview is dark text on white in the dark theme', async ({ app }) => {
	await useScenario('chat-hello');
	const input = app.getByPlaceholder(/Type a message/);
	await input.fill('hello');
	await input.press('Enter');
	await expect(app.getByText('Hello from the fake model.', { exact: false })).toBeVisible();
	await app.getByRole('button', { name: 'Email this answer' }).click();
	const dialog = app.getByRole('dialog');
	await dialog
		.getByLabel('Message')
		.fill('# Title\n\n## Section\n\nA paragraph with a [link](https://example.com).\n\n- item');
	await dialog.getByRole('button', { name: 'Preview' }).click();
	const preview = dialog.getByLabel('Preview');
	const colours = await preview.evaluate((el) =>
		Object.fromEntries(
			['h1', 'h2', 'p', 'li', 'a'].map((t) => [t, getComputedStyle(el.querySelector(t)!).color])
		)
	);
	const dark = 'rgb(34, 34, 34)';
	expect(colours).toEqual({ h1: dark, h2: dark, p: dark, li: dark, a: 'rgb(26, 95, 180)' });
});
