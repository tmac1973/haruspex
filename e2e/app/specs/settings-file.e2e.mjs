import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REMOTE, seed } from '../helpers.mjs';
import { e2eDataDirs } from '../wdio.conf.mjs';

/**
 * Saved settings live in a file every build shares (issue #562): a dev build
 * and a packaged one load the frontend from different origins, so each has
 * its own `localStorage`. Emptying `localStorage` and reloading is what a
 * different origin looks like to the app.
 */
describe('settings saved to the shared file', () => {
	const file = join(e2eDataDirs()[0], 'webview-store.json');
	const saved = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).items : {});

	it('come back in a webview whose localStorage is empty', async () => {
		await seed({ ...REMOTE, ttsVoice: 'bm_george' });
		expect(JSON.parse(saved()['haruspex-settings']).ttsVoice).toBe('bm_george');

		// A change made in the app reaches the file.
		await (await $('button=Jobs')).click();
		await browser.waitUntil(() => saved()['haruspex.activeTab'] === 'jobs', {
			timeout: 10_000,
			timeoutMsg: 'switching to Jobs never reached webview-store.json'
		});

		await browser.execute(() => {
			localStorage.clear();
			location.reload();
		});
		await browser.pause(500);
		await browser.waitUntil(
			() =>
				browser.execute(() => document.readyState === 'complete' && !!window.__haruspexSavedLoaded),
			{ timeout: 30_000, timeoutMsg: 'the app did not come back after the reload' }
		);
		const restored = await browser.execute(() => ({
			settings: localStorage.getItem('haruspex-settings'),
			tab: localStorage.getItem('haruspex.activeTab')
		}));
		expect(JSON.parse(restored.settings).ttsVoice).toBe('bm_george');
		expect(restored.tab).toBe('jobs');
		await (await $('button=Jobs')).waitForDisplayed({ timeout: 30_000 });
	});
});
