import { test, expect } from './fixtures';

const SECTIONS = [
	'General',
	'Inference',
	'Chat',
	'Memory',
	'Skills',
	'Audio',
	'Search',
	'Network',
	'Integrations',
	'Screen',
	'Shell',
	'Image',
	'Guest chat',
	'Remote control',
	'Feedback'
];

test('every Settings section opens without an error', async ({ app }) => {
	const errors: string[] = [];
	app.on('pageerror', (e) => errors.push(e.message));
	await app.getByRole('button', { name: 'Settings' }).click();
	// Scoped to the rail: the app's own Chat tab is a button too.
	const rail = app.getByRole('navigation', { name: 'Settings categories' });
	for (const name of SECTIONS) {
		await rail.getByRole('button', { name, exact: true }).click();
		await expect(app.getByRole('heading', { level: 2 }).first()).toBeVisible();
	}
	expect(errors).toEqual([]);
});
