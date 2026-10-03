// @vitest-environment node
/**
 * Live checks against a real ComfyUI. Skipped unless pointed at one:
 *
 *   HARUSPEX_IMAGE_E2E=1 \
 *   HARUSPEX_IMAGE_BACKEND_URL=http://127.0.0.1:8188 \
 *   npx vitest run src/lib/image/comfyui/live
 *
 * `HARUSPEX_IMAGE_MING_MODEL` overrides the Ming diffusion model's filename.
 * The server needs that model plus a Ming text encoder and VAE. Set
 * `HARUSPEX_IMAGE_QWEN21_MODEL` to also check Qwen-Image-2.1, which is
 * non-commercial and so not assumed to be installed.
 *
 * Kept apart from the unit tests because these are the only ones that can
 * catch what stubbed tests hid for this whole feature: a graph that validates
 * and runs and produces the wrong picture.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { getSettings, updateSettings } from '$lib/stores/settings';
import { comfyUiBackend } from './backend';

declare const process: { env: Record<string, string | undefined> };

const LIVE = process.env.HARUSPEX_IMAGE_E2E === '1';
const BACKEND_URL = process.env.HARUSPEX_IMAGE_BACKEND_URL ?? '';
const MING_MODEL =
	process.env.HARUSPEX_IMAGE_MING_MODEL ?? 'ming_image_0.1_design_int8_convrot.safetensors';
const QWEN21_MODEL = process.env.HARUSPEX_IMAGE_QWEN21_MODEL ?? '';
const live = LIVE && BACKEND_URL ? it : it.skip;
const liveQwen = LIVE && BACKEND_URL && QWEN21_MODEL ? it : it.skip;

/** The chunks of a PNG, by type. */
function chunks(png: Uint8Array): Array<{ type: string; data: Uint8Array }> {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const out: Array<{ type: string; data: Uint8Array }> = [];
	for (let pos = 8; pos < png.length; ) {
		const len = view.getUint32(pos);
		out.push({
			type: String.fromCharCode(...png.slice(pos + 4, pos + 8)),
			data: png.slice(pos + 8, pos + 8 + len)
		});
		pos += 12 + len;
	}
	return out;
}

/** Undo one scanline's PNG filter in place, given the previous unfiltered row. */
function unfilter(filter: number, line: Uint8Array, prev: Uint8Array | null, bpp: number): void {
	for (let x = 0; x < line.length; x++) {
		const a = x >= bpp ? line[x - bpp] : 0;
		const b = prev ? prev[x] : 0;
		const c = prev && x >= bpp ? prev[x - bpp] : 0;
		const p = a + b - c;
		const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
		const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
		line[x] = (line[x] + [0, a, b, (a + b) >> 1, paeth][filter]) & 0xff;
	}
}

/** Fraction of pixels with alpha below 8, from a non-interlaced 8-bit PNG. */
async function transparentFraction(png: Uint8Array): Promise<number> {
	const all = chunks(png);
	const ihdr = new DataView(all[0].data.buffer, all[0].data.byteOffset);
	const [width, height] = [ihdr.getUint32(0), ihdr.getUint32(4)];
	expect(all[0].data[8]).toBe(8);
	// 6 = RGBA. Anything else has no alpha channel at all, which is the failure.
	if (all[0].data[9] !== 6) return 0;
	const idat = all.filter((c) => c.type === 'IDAT').map((c) => c.data);
	const stream = new Blob(idat as BlobPart[])
		.stream()
		.pipeThrough(new DecompressionStream('deflate'));
	const raw = new Uint8Array(await new Response(stream).arrayBuffer());
	const stride = width * 4;
	let prev: Uint8Array | null = null;
	let clear = 0;
	for (let y = 0; y < height; y++) {
		const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		unfilter(raw[y * (stride + 1)], line, prev, 4);
		for (let i = 3; i < stride; i += 4) if (line[i] < 8) clear++;
		prev = line;
	}
	return clear / (width * height);
}

describe('ComfyUI, live (opt-in)', () => {
	const saved = {
		url: getSettings().imageBackendBaseUrl,
		model: getSettings().imageComfyCheckpoint
	};
	afterAll(() =>
		updateSettings({ imageBackendBaseUrl: saved.url, imageComfyCheckpoint: saved.model })
	);

	live(
		'a transparent Ming-Image request comes back with real alpha',
		async () => {
			updateSettings({ imageBackendBaseUrl: BACKEND_URL, imageComfyCheckpoint: MING_MODEL });
			expect(await comfyUiBackend.probe()).toMatchObject({ ok: true });
			expect((await comfyUiBackend.capabilities()).transparency).toBe(true);
			const r = await comfyUiBackend.generate({
				prompt: '16-bit pixel art, bold dark outlines. A single game sprite of an iron sword.',
				width: 1024,
				height: 1024,
				seed: 1,
				transparent: true
			});
			// The spike measured 53-95% clear on singles; half is a floor that an
			// opaque result (0%) cannot reach by accident.
			expect(await transparentFraction(r.images[0].bytes)).toBeGreaterThan(0.5);
		},
		600_000
	);

	live(
		'an opaque Ming-Image request has no transparent background',
		async () => {
			updateSettings({ imageBackendBaseUrl: BACKEND_URL, imageComfyCheckpoint: MING_MODEL });
			const r = await comfyUiBackend.generate({
				prompt: '16-bit pixel art. A single game sprite of an iron sword on a white background.',
				width: 1024,
				height: 1024,
				seed: 1
			});
			expect(await transparentFraction(r.images[0].bytes)).toBeLessThan(0.05);
		},
		600_000
	);

	liveQwen(
		'a transparent Qwen-Image-2.1 request comes back with real alpha',
		async () => {
			updateSettings({ imageBackendBaseUrl: BACKEND_URL, imageComfyCheckpoint: QWEN21_MODEL });
			const r = await comfyUiBackend.generate({
				prompt: '16-bit pixel art, bold dark outlines. A single game sprite of an iron sword.',
				width: 1024,
				height: 1024,
				seed: 1,
				transparent: true
			});
			expect(await transparentFraction(r.images[0].bytes)).toBeGreaterThan(0.5);
		},
		900_000
	);
});
