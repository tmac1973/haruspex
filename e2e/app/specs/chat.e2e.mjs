import { REMOTE, seed, sendChat, useScenario, byText, FAKE_LLM } from '../helpers.mjs';

describe('chat in the real app', () => {
	it('sends a message and shows the scripted answer', async () => {
		await useScenario('chat-hello');
		await seed(REMOTE);
		await sendChat('hello there');
		await (await byText('Hello from the fake model.')).waitForDisplayed({ timeout: 30_000 });

		const requests = await (await fetch(`${FAKE_LLM}/__requests`)).json();
		const last = requests.at(-1).messages.at(-1);
		expect(JSON.stringify(last)).toContain('hello there');
	});
});
