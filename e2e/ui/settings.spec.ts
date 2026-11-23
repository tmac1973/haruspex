import { test, expect } from './fixtures';

test('every Settings section opens without an error', async ({ app }) => {
	const errors: string[] = [];
	app.on('pageerror', (e) => errors.push(e.message));
	await app.getByRole('button', { name: 'Settings' }).click();
	// Scoped to the rail: the app's own Chat tab is a button too. Every
	// category the rail shows is opened, so a new one is covered without
	// adding it here.
	const items = app.getByRole('navigation', { name: 'Settings categories' }).getByRole('button');
	const count = await items.count();
	expect(count).toBeGreaterThanOrEqual(20);
	for (let i = 0; i < count; i++) {
		const item = items.nth(i);
		const name = (await item.textContent())?.trim();
		await item.click();
		await expect(app.getByRole('heading', { level: 2 }).first(), name).toBeVisible();
	}
	expect(errors).toEqual([]);
});
