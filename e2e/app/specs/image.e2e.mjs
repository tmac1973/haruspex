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

	/**
	 * A detail line's text from inside the Test generation section, or a marker
	 * when it is not rendered.
	 *
	 * Scoped to that section deliberately. The backend-probe section above it
	 * renders its own `.detail`, conditionally `.bad`, so an unscoped selector
	 * reports the probe's text as though it were the generation error — the
	 * same kind of misleading diagnostic this helper exists to replace.
	 */
	const detail = async (selector) => {
		const section = await (await $('h2=Test generation')).parentElement();
		const el = await section.$(selector);
		return (await el.isExisting()) ? await el.getText() : '(not shown)';
	};

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

		// Checked before the preview, because from the outside two different
		// failures look identical: the app never asking ComfyUI at all, and the
		// app asking but never rendering what came back. Waiting only on the
		// <img> reports both as "still not displayed".
		await browser.waitUntil(() => comfy.prompts.size === 1, {
			timeout: 30_000,
			timeoutMsg: `the app never submitted a prompt to the fake ComfyUI on ${port}`
		});

		const preview = await $('img[alt="Test generation"]');
		try {
			await preview.waitForDisplayed({ timeout: 60_000 });
		} catch (e) {
			// The panel puts the reason on screen in `testError`; a bare wdio
			// timeout discards it, which is how an earlier failure here left
			// nothing to diagnose. Carry it into the message.
			throw new Error(
				`${e.message}\n` +
					`  prompt submitted, so the request reached ComfyUI\n` +
					`  panel error: ${await detail('.detail.bad')}\n` +
					`  panel progress: ${await detail('.detail')}`
			);
		}
		// The picture loaded through the haruspex-img scheme, so it was stored.
		await browser.waitUntil(async () => (await preview.getProperty('naturalWidth')) === 2, {
			timeout: 15_000,
			timeoutMsg: 'the stored test image never loaded'
		});
		expect(comfy.prompts.size).toBe(1);
	});
});
