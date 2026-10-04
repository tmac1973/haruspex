import { test, expect } from './fixtures';

const SECTIONS = [
	'General',
	'Inference',
	'Agent',
	'Memory',
	'Audio',
	'Search',
	'Network',
	'Integrations',
	'Screen',
	'Shell',
	'Image',
	'Remote access',
	'Feedback'
];

test('every Settings section opens without an error', async ({ app }) => {
	const errors: string[] = [];
	app.on('pageerror', (e) => errors.push(e.message));
	await app.getByRole('button', { name: 'Settings' }).click();
	for (const name of SECTIONS) {
		await app.getByRole('button', { name, exact: true }).click();
		await expect(app.getByRole('heading', { level: 2 }).first()).toBeVisible();
	}
	expect(errors).toEqual([]);
});
