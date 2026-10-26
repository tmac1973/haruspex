// @vitest-environment node
/**
 * A live upscale against a real ComfyUI with ComfyUI-Manager. Installs
 * Real-ESRGAN x4plus (67 MB) through Manager when the server lacks it, then
 * upscales a picture of yours:
 *
 *   HARUSPEX_IMAGE_E2E=1 \
 *   HARUSPEX_IMAGE_BACKEND_URL=http://127.0.0.1:8188 \
 *   HARUSPEX_IMAGE_UPSCALE_SOURCE=/path/to/picture.png \
 *   npx vitest run src/lib/image/comfyui/live.upscale
 *
 * `HARUSPEX_IMAGE_OUT_DIR` keeps the result, to look at.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import type { ComfyModelSet } from '#lib/ipc/gen/ComfyModelSet.ts';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import { comfyUiBackend, pngSize } from './backend';
import { installViaManager, managerApi, missingFiles } from './provision';

declare const process: { env: Record<string, string | undefined> };

const LIVE = process.env.HARUSPEX_IMAGE_E2E === '1';
const BACKEND_URL = process.env.HARUSPEX_IMAGE_BACKEND_URL ?? '';
const SOURCE = process.env.HARUSPEX_IMAGE_UPSCALE_SOURCE ?? '';
const OUT_DIR = process.env.HARUSPEX_IMAGE_OUT_DIR ?? '';
const live = LIVE && BACKEND_URL && SOURCE ? it : it.skip;

/** As `comfy_upscaler_set` lists it. */
const UPSCALER: ComfyModelSet = {
	family: 'upscaler',
	label: 'Upscaler — Real-ESRGAN x4plus',
	license: 'BSD 3-Clause — commercial use allowed.',
	license_url: 'https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE',
	commercial_use: true,
	vram_mb: 1024,
	ram_mb: 1024,
	files: [
		{
			folder: 'upscale_models',
			filename: 'RealESRGAN_x4plus.pth',
			url: 'https://huggingface.co/lllyasviel/Annotators/resolve/main/RealESRGAN_x4plus.pth',
			sha256: '4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1',
			size_bytes: 67_040_989
		}
	]
};

const saved = getSettings().imageBackendBaseUrl;
afterAll(() => updateSettings({ imageBackendBaseUrl: saved }));

describe('ComfyUI upscale, live', () => {
	live(
		'installs the upscaler through Manager and makes a picture four times larger',
		async () => {
			updateSettings({ imageBackendBaseUrl: BACKEND_URL });
			const cfg = { baseUrl: BACKEND_URL, apiKey: '' };
			const missing = await missingFiles(cfg, UPSCALER);
			if (missing.length > 0) {
				const which = await managerApi(cfg);
				expect(which).not.toBeNull();
				await installViaManager(cfg, which!, missing, () => {});
				expect(await missingFiles(cfg, UPSCALER)).toEqual([]);
			}
			expect((await comfyUiBackend.capabilities()).upscale).toBe(true);

			const source = readFileSync(SOURCE);
			const started = Date.now();
			const out = await comfyUiBackend.upscale!({ name: 'source.png', bytes: Array.from(source) });
			console.warn(`upscaled in ${Date.now() - started} ms`);
			if (OUT_DIR) writeFileSync(`${OUT_DIR}/comfy-upscaled.png`, out);
			const before = pngSize(source)!;
			expect(pngSize(out)).toEqual({ width: before.width * 4, height: before.height * 4 });
		},
		900_000
	);
});
