import { REMOTE, seed } from '../helpers.mjs';
import { createFakeComfy, CHECKPOINT } from '../../fakes/comfyui.mjs';

/**
 * Settings → Image → Generate a test image, through the app's real ComfyUI
 * client (IPC into comfy.rs, HTTP from Rust) against a fake ComfyUI.
 */
describe('a test image from ComfyUI', () => {
	let comfy;
	let port;
	before(async () => {
		comfy = createFakeComfy();
		port = await comfy.listen();
	});
	after(() => comfy.close());

	it('generates, stores and shows the picture', async () => {
		await seed({
			...REMOTE,
			imageBackendKind: 'comfyui',
			imageBackendBaseUrl: `http://127.0.0.1:${port}`,
			imageComfyCheckpoint: CHECKPOINT
		});
		await (await $('button[aria-label="Settings"]')).click();
		await (await $('button=Image')).click();
		await (await $('button=Generate a test image')).click();

		const preview = await $('img[alt="Test generation"]');
		await preview.waitForDisplayed({ timeout: 60_000 });
		// The picture loaded through the haruspex-img scheme, so it was stored.
		await browser.waitUntil(async () => (await preview.getProperty('naturalWidth')) === 2, {
			timeout: 15_000,
			timeoutMsg: 'the stored test image never loaded'
		});
		expect(comfy.prompts.size).toBe(1);
	});
});
