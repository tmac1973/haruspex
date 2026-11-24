import { test, expect, useScenario, llmRequests } from './fixtures';

async function newNotebook(app: import('@playwright/test').Page, title: string) {
	await app.getByRole('tab', { name: 'Notebooks' }).click();
	await app.getByRole('button', { name: '+ New' }).click();
	const name = app.getByLabel('New notebook title');
	await name.fill(title);
	await name.press('Enter');
	await expect(app.getByLabel('Notebook title')).toHaveValue(title);
}

test('a notebook takes a table and a checklist typed into by hand', async ({ app }) => {
	await newNotebook(app, 'Groceries');

	await app.getByRole('button', { name: '+ Add card' }).click();
	await app.getByRole('menuitem', { name: 'Table' }).click();
	await app.getByRole('cell').first().getByRole('button').click();
	const cell = app.getByLabel('Name', { exact: true });
	await cell.fill('Apples');
	await cell.press('Enter');
	await expect(app.getByRole('button', { name: 'Apples' })).toBeVisible();

	await app.getByRole('button', { name: '+ Add card' }).click();
	await app.getByRole('menuitem', { name: 'Checklist' }).click();
	const item = app.getByLabel('Item').first();
	await item.fill('Bread');
	await item.press('Enter');
	await expect(app.getByLabel('Item')).toHaveCount(2);
	await expect(app.getByText('0 of 2 done')).toBeVisible();
});

test("a notebook's chat adds a table through the notebook tools", async ({ app }) => {
	await useScenario('notebook-chat');
	await newNotebook(app, 'Speakers');

	const box = app.getByLabel('Message');
	await box.fill('make a speakers table');
	await box.press('Enter');

	await expect(app.getByText('I added a table of two speakers to the notebook.')).toBeVisible();
	await expect(app.getByRole('button', { name: 'Soundcore Motion 300' })).toBeVisible();
	await expect(app.getByRole('link', { name: 'example.com/b' })).toBeVisible();
	await expect(app.getByText('From Notebook chat: Speakers')).toBeVisible();

	// The turn had the notebook in its prompt and its tools loaded, not deferred.
	const [first] = await llmRequests();
	expect(JSON.stringify(first.messages[0])).toContain('notebook \\"Speakers\\"');
	const names = (first as unknown as { tools: { function: { name: string } }[] }).tools.map(
		(t) => t.function.name
	);
	expect(names).toContain('notebook_table_rows');
});
