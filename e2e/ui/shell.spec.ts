import { test, expect, useScenario } from './fixtures';

test.use({
	// The Code tab is hidden on Windows, and Playwright's desktop Chrome says
	// it is Windows.
	userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome'
});

test('the assistant toggles between Read-only and Full access', async ({ app }) => {
	await app.getByRole('tab', { name: 'Shell', exact: true }).click();
	await app.getByRole('button', { name: 'Open assistant sidebar' }).click();
	const lock = app.getByRole('button', { name: 'Read-only' });
	await expect(lock).toHaveAttribute('aria-pressed', 'false');
	await lock.click();
	await expect(app.getByRole('button', { name: 'Full access' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
});

test('Open in Code starts a Code session in the shell’s folder', async ({ app }) => {
	await app.getByRole('tab', { name: 'Shell', exact: true }).click();
	await app.getByRole('button', { name: 'Open assistant sidebar' }).click();
	await app.getByRole('button', { name: 'Open in Code' }).click();

	await expect(app.getByRole('tab', { name: 'Code', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	// The mock shell reports /e2e/project as its folder.
	await expect(app.getByRole('tab', { name: /project · new session/ })).toBeVisible();
});

test('a detached shell window asks its own command approvals', async ({ app }) => {
	await useScenario('shell-full-access');
	await app.goto('/shell/1?access=full');
	await expect(app.getByRole('button', { name: 'Full access' })).toBeVisible();

	const input = app.getByPlaceholder(/Ask the assistant/);
	await input.fill('clean the build');
	await input.press('Enter');

	await expect(app.getByRole('heading', { name: 'Run this command?' })).toBeVisible({
		timeout: 15_000
	});
});
