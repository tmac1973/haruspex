import { test, expect, useScenario, llmRequests } from './fixtures';

test('a research job is created, run, and shows each step’s output', async ({ app }) => {
	await useScenario('research-job');
	await app
		.getByRole('tab', { name: 'Jobs' })
		.or(app.getByRole('button', { name: 'Jobs' }))
		.first()
		.click();
	await app.getByRole('button', { name: '+ New' }).click();

	await app.getByPlaceholder('Morning headlines').fill('Weather digest');
	await app.getByPlaceholder('What should this step do?').fill('Find the weather in Lisbon.');
	await app.getByRole('button', { name: '+ Add step' }).click();
	await app.getByPlaceholder(/previous step’s output/).fill('Summarise it in one line.');
	await app.getByRole('button', { name: 'Save' }).click();

	await app.getByTitle(/^Run now/).click();
	await expect(app.getByText('In short: sunny and mild.').first()).toBeVisible({ timeout: 15_000 });
	await expect(app.getByText(/sunny, 21 °C/).first()).toBeVisible();

	// The second step was given the first step's output.
	const requests = await llmRequests();
	const second = requests.find((r) => JSON.stringify(r.messages).includes('Summarise it'));
	expect(JSON.stringify(second?.messages)).toContain('21 °C');
});
