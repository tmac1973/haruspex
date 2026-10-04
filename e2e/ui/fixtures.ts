import { test as base, expect, type Page } from '@playwright/test';
import { FAKE_LLM_PORT } from '../../playwright.config';

export const FAKE_LLM = `http://127.0.0.1:${FAKE_LLM_PORT}`;

/** Remote mode pointed at the fake LLM: no local server, no first-run wizard. */
export const SEEDED_SETTINGS = {
	dismissedStartupNotice: true,
	inferenceBackend: {
		mode: 'remote',
		remoteBaseUrl: FAKE_LLM,
		remoteServerUrls: [FAKE_LLM],
		remoteModelId: 'fake-model',
		remoteContextSize: 32768,
		remoteVisionSupported: false,
		remoteBackendKind: 'generic'
	}
};

/** Load a scenario into the fake LLM; it also forgets earlier requests. */
export async function useScenario(name: string): Promise<void> {
	const r = await fetch(`${FAKE_LLM}/__scenario`, {
		method: 'POST',
		body: JSON.stringify({ name })
	});
	if (!r.ok) throw new Error(`fake LLM refused scenario ${name}: ${await r.text()}`);
}

/** Every chat request the fake has received since the scenario was loaded. */
export async function llmRequests(): Promise<{ messages: { role: string; content: unknown }[] }[]> {
	return (await fetch(`${FAKE_LLM}/__requests`)).json();
}

/**
 * A page with the settings seeded before the app loads, and a check after
 * each test that nothing called an IPC command the mock table lacks.
 */
export const test = base.extend<{ app: Page; settings: Record<string, unknown> }>({
	/** Settings merged over SEEDED_SETTINGS for one test, with `test.use`. */
	settings: [{}, { option: true }],
	app: async ({ page, settings }, use) => {
		const missing: string[] = [];
		page.on('console', (m) => {
			const hit = /e2e: no mock for IPC command "([^"]+)"/.exec(m.text());
			if (hit) missing.push(hit[1]);
		});
		page.on('pageerror', (e) => {
			const hit = /e2e: no mock for IPC command "([^"]+)"/.exec(e.message);
			if (hit) missing.push(hit[1]);
		});
		// Nothing leaves this machine: the update check, image fetches and the
		// like are aborted, so a test can never pass or fail on the internet.
		const outside: string[] = [];
		await page.route('**/*', (route) => {
			const host = new URL(route.request().url()).hostname;
			if (host === 'localhost' || host === '127.0.0.1') return route.continue();
			outside.push(route.request().url());
			return route.abort('blockedbyclient');
		});
		await page.addInitScript(
			(settings) => {
				if (!sessionStorage.getItem('e2e-seeded')) {
					localStorage.clear();
					localStorage.setItem('haruspex-settings', JSON.stringify(settings));
					sessionStorage.setItem('e2e-seeded', '1');
				}
			},
			{ ...SEEDED_SETTINGS, ...settings }
		);
		await page.goto('/');
		await use(page);
		expect([...new Set(missing)], 'IPC commands with no mock').toEqual([]);
		test
			.info()
			.annotations.push(
				...[...new Set(outside)].map((url) => ({ type: 'blocked request', description: url }))
			);
	}
});

export { expect };
