// @vitest-environment node
/**
 * A live edit against a real ComfyUI. Skipped unless pointed at one with
 * Qwen-Image-2.1 (or its Turbo), which is non-commercial and so not assumed:
 *
 *   HARUSPEX_IMAGE_E2E=1 \
 *   HARUSPEX_IMAGE_BACKEND_URL=http://127.0.0.1:8188 \
 *   HARUSPEX_IMAGE_QWEN21_MODEL=qwen_image_2.1_turbo_int8_convrot.safetensors \
 *   npx vitest run src/lib/image/comfyui/live.edit
 *
 * `HARUSPEX_IMAGE_OUT_DIR` keeps the picture drawn and its edit, to look at:
 * the stubbed tests show the graph is wired, not that the edit kept the
 * picture.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import { comfyUiBackend } from './backend';

declare const process: { env: Record<string, string | undefined> };

const LIVE = process.env.HARUSPEX_IMAGE_E2E === '1';
const BACKEND_URL = process.env.HARUSPEX_IMAGE_BACKEND_URL ?? '';
const QWEN21_MODEL = process.env.HARUSPEX_IMAGE_QWEN21_MODEL ?? '';
const OUT_DIR = process.env.HARUSPEX_IMAGE_OUT_DIR ?? '';
const live = LIVE && BACKEND_URL && QWEN21_MODEL ? it : it.skip;

const saved = {
	url: getSettings().imageBackendBaseUrl,
	ckpt: getSettings().imageComfyCheckpoint
};
afterAll(() => {
	updateSettings({ imageBackendBaseUrl: saved.url, imageComfyCheckpoint: saved.ckpt });
});

describe('ComfyUI edit, live', () => {
	live(
		'edits a picture it drew, keeping its shape',
		async () => {
			updateSettings({ imageBackendBaseUrl: BACKEND_URL, imageComfyCheckpoint: QWEN21_MODEL });
			expect(await comfyUiBackend.capabilities()).toMatchObject({ edit: true });

			const drawn = await comfyUiBackend.generate({
				prompt: 'a photo of a red vintage car parked on a cobblestone street, sunny day',
				width: 1024,
				height: 768,
				seed: 21
			});
			const source = drawn.images[0].bytes;
			const edited = await comfyUiBackend.generate({
				prompt:
					'Make the car blue and turn the scene into a snowy winter evening with a street lamp. ' +
					'Keep the car and the street the same.',
				width: 1024,
				height: 768,
				seed: 22,
				edit: { images: [{ name: 'car.png', bytes: Array.from(source) }] }
			});
			const out = edited.images[0];
			if (OUT_DIR) {
				writeFileSync(`${OUT_DIR}/comfy-car.png`, source);
				writeFileSync(`${OUT_DIR}/comfy-car-edit.png`, out.bytes);
			}
			// Sized from the picture: its 4:3 shape at about a megapixel.
			expect(out.width / out.height).toBeCloseTo(1024 / 768, 1);
			expect(Math.abs(out.width * out.height - 1024 * 768)).toBeLessThan(80_000);
		},
		600_000
	);
});
