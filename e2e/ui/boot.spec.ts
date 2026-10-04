import { test, expect } from './fixtures';

test('the app boots in remote mode against the fake model', async ({ app }) => {
	await expect(app.getByText(/fake-model/).first()).toBeVisible({ timeout: 30_000 });
});
