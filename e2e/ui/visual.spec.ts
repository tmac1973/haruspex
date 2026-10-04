import { test, expect, useScenario } from './fixtures';

/**
 * Screenshots of the main pages, compared with committed baselines. Fonts and
 * rendering differ between machines, so these run only inside the pinned
 * Playwright image (`npm run e2e:ui:visual`, and CI's e2e-ui job), where the
 * baselines were made. Update them with `npm run e2e:ui:visual -- --update-snapshots`.
 */
/** What changes from run to run: timings, and token counts that follow the date in the prompt. */
const VOLATILE = ['.elapsed', '.tok-rate', '.context-indicator'];

test.describe('@visual', () => {
	test.skip(!process.env.E2E_VISUAL, 'screenshots run in the pinned Playwright image only');

	test('chat with an answer', async ({ app }) => {
		await useScenario('chat-hello');
		const input = app.getByPlaceholder(/Type a message/);
		await input.fill('hello there');
		await input.press('Enter');
		await expect(app.getByText('Hello from the fake model.', { exact: false })).toBeVisible();
		await expect(app).toHaveScreenshot('chat.png', {
			mask: VOLATILE.map((s) => app.locator(s))
		});
	});

	test('settings', async ({ app }) => {
		await app.getByRole('button', { name: 'Settings' }).click();
		await expect(app.getByRole('heading', { level: 2 }).first()).toBeVisible();
		await expect(app).toHaveScreenshot('settings.png', {
			mask: VOLATILE.map((s) => app.locator(s))
		});
	});

	test('jobs, empty', async ({ app }) => {
		await app
			.getByRole('tab', { name: 'Jobs' })
			.or(app.getByRole('button', { name: 'Jobs' }))
			.first()
			.click();
		await expect(app.getByRole('button', { name: '+ New' })).toBeVisible();
		await expect(app).toHaveScreenshot('jobs.png', {
			mask: VOLATILE.map((s) => app.locator(s))
		});
	});
});
