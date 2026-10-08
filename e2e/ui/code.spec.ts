import { test, expect, useScenario } from './fixtures';

test.use({
	settings: { codeLastRoot: '/e2e/project' },
	// The Code tab is hidden on Windows, and Playwright's desktop Chrome says
	// it is Windows.
	userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome'
});

test('a Code session edits a file and runs a command, shown as cards', async ({ app }) => {
	await useScenario('code-tab');
	await app.getByRole('tab', { name: 'Code' }).click();

	// The new-session dialog starts from the last folder used.
	await app.getByRole('button', { name: 'New session' }).first().click();
	await expect(app.getByText('/e2e/project')).toBeVisible();
	await app.getByRole('button', { name: 'Start session' }).click();

	const input = app.getByRole('textbox', { name: 'Message' });
	await input.fill('fix the readme typo');
	await input.press('Enter');

	const transcript = app.getByTestId('code-transcript');
	await expect(transcript.getByText('Fixed the typo in README.md.')).toBeVisible({
		timeout: 15_000
	});
	const diff = transcript.getByTestId('diff-card');
	await expect(diff).toContainText('README.md');
	await expect(diff).toContainText('# Hello');
	const command = transcript.getByTestId('command-card');
	await expect(command).toContainText('cat README.md');
	await expect(command).toContainText('exit 0');

	// The session is saved under its folder in the sidebar, named by the message.
	const sidebar = app.getByRole('complementary', { name: 'Code sessions' });
	await expect(sidebar.getByText('project')).toBeVisible();
	await expect(sidebar.getByRole('button', { name: 'fix the readme typo' })).toBeVisible();
});
