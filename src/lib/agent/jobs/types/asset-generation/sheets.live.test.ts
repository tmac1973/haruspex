// @vitest-environment node
/**
 * A real sheet through a real ComfyUI. Skipped unless pointed at one:
 *
 *   HARUSPEX_IMAGE_E2E=1 \
 *   HARUSPEX_IMAGE_BACKEND_URL=http://127.0.0.1:8188 \
 *   HARUSPEX_SHEET_OUT=/tmp/sheet.png \
 *   npx vitest run sheets.live
 *
 * It writes the sheet to HARUSPEX_SHEET_OUT. Cut it with the Rust side:
 *
 *   HARUSPEX_SPLIT_IN=/tmp/sheet.png \
 *     cargo test --lib split_a_real_sheet -- --ignored --nocapture
 *
 * Two halves because the cut runs in Rust behind Tauri, and this suite has no
 * Tauri. Together they are the sheet path minus the job runner.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { getSettings, updateSettings } from '$lib/stores/settings';
import { comfyUiBackend } from '$lib/image/comfyui/backend';
import { sheetRequest } from './sheets';
import type { AssetEntry, AssetSpec } from '$lib/assets/spec/types';

declare const process: { env: Record<string, string | undefined> };

const LIVE = process.env.HARUSPEX_IMAGE_E2E === '1';
const URL = process.env.HARUSPEX_IMAGE_BACKEND_URL ?? '';
const OUT = process.env.HARUSPEX_SHEET_OUT ?? '';
const MODEL =
	process.env.HARUSPEX_IMAGE_MING_MODEL ?? 'ming_image_0.1_design_int8_convrot.safetensors';
const live = LIVE && URL && OUT ? it : it.skip;

const SUBJECTS = [
	'an iron sword',
	'a red health potion bottle',
	'a gold coin',
	'a rusty wrench',
	'a tin of canned food',
	'a gas mask',
	'a red jerrycan',
	'a first aid kit',
	'a revolver'
];

describe('a sheet, live (opt-in)', () => {
	const saved = {
		url: getSettings().imageBackendBaseUrl,
		model: getSettings().imageComfyCheckpoint
	};
	afterAll(() =>
		updateSettings({ imageBackendBaseUrl: saved.url, imageComfyCheckpoint: saved.model })
	);

	live(
		'nine subjects come back as one transparent PNG',
		async () => {
			updateSettings({ imageBackendBaseUrl: URL, imageComfyCheckpoint: MODEL });
			const entries: AssetEntry[] = SUBJECTS.map((prompt, i) => ({
				id: `s${i}`,
				kind: 'sprite',
				prompt,
				out: `o/${i}.png`
			}));
			const spec = {
				style: {
					prompt:
						'16-bit pixel art, flat shading, bold dark outlines, desaturated rust-and-concrete palette'
				}
			} as AssetSpec;
			const r = await comfyUiBackend.generate(sheetRequest(entries, spec));
			// Node's own module, typed by hand: this project has no @types/node.
			const fsModule = 'node:fs/promises';
			const { writeFile } = (await import(/* @vite-ignore */ fsModule)) as {
				writeFile: (path: string, data: Uint8Array) => Promise<void>;
			};
			await writeFile(OUT, r.images[0].bytes);
			expect(r.images[0].bytes.length).toBeGreaterThan(1000);
		},
		600_000
	);
});
