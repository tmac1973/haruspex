import { test, expect, useScenario, llmRequests } from './fixtures';

test.beforeEach(() => useScenario('chat-hello'));

test('a message gets the scripted, streamed answer', async ({ app }) => {
	const input = app.getByPlaceholder(/Type a message/);
	await input.fill('hello there');
	await input.press('Enter');
	await expect(app.getByText('Hello from the fake model.', { exact: false })).toBeVisible();

	// The app sent the user's words, and a system prompt ahead of them.
	const [first] = await llmRequests();
	expect(first.messages[0].role).toBe('system');
	expect(JSON.stringify(first.messages.at(-1))).toContain('hello there');
});

test('a scripted tool call shows its step, then the answer', async ({ app }) => {
	await useScenario('web-search');
	const input = app.getByPlaceholder(/Type a message/);
	await input.fill('search for the bronze liver');
	await input.press('Enter');
	await expect(app.getByText('haruspex bronze liver').first()).toBeVisible();
	await expect(app.getByText(/bronze model of a sheep/)).toBeVisible();
});
