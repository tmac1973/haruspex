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

test('many shells stay inside the window, and each can be reached', async ({ app }) => {
	await app.getByRole('tab', { name: 'Shell', exact: true }).click();
	const strip = app.getByRole('tablist', { name: 'Shell tabs' });
	const tabs = strip.getByRole('tab');
	await expect(tabs).toHaveCount(1);
	const add = app.getByRole('button', { name: 'New shell' });
	for (let i = 1; i < 24; i++) await add.click();
	await expect(tabs).toHaveCount(24);

	// The strip and its New shell button fit the window.
	const width = await app.evaluate(() => window.innerWidth);
	const box = await strip.boundingBox();
	expect(box!.x + box!.width).toBeLessThanOrEqual(width);
	const addBox = await add.boundingBox();
	expect(addBox!.x + addBox!.width).toBeLessThanOrEqual(width);

	// The newest tab is active and scrolled into view.
	await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
	await expect(tabs.last()).toBeInViewport();

	// The first is reached with the mouse, and comes back into view.
	await tabs.first().click();
	await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
	await expect(tabs.first()).toBeInViewport();

	// And with the keyboard: → walks the tabs, End jumps to the last, Enter opens it.
	// Opening a shell focuses its terminal, so start from a focused tab.
	await tabs.first().focus();
	await app.keyboard.press('ArrowRight');
	await expect(tabs.nth(1)).toBeFocused();
	await app.keyboard.press('End');
	await expect(tabs.last()).toBeFocused();
	await app.keyboard.press('Enter');
	await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
	await expect(tabs.last()).toBeInViewport();
});
