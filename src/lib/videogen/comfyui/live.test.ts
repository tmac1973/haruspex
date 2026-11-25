// @vitest-environment node
/**
 * Live checks against a real ComfyUI with the video models installed.
 * Skipped unless pointed at one:
 *
 *   HARUSPEX_VIDEO_E2E=1 \
 *   HARUSPEX_VIDEO_COMFY_URL=http://asmodean:8188 \
 *   npx vitest run src/lib/videogen/comfyui/live
 *
 * `HARUSPEX_VIDEO_FAMILIES` limits it to some families, comma-separated
 * (`wan22_ti2v_5b,wan22_i2v_14b,wan22_s2v,ltx23`); all run by default.
 * Each runs its real graph, small and short, through the shared run loop and
 * checks a WebM came back. `HARUSPEX_VIDEO_FULL=1` runs each at its default
 * size and length instead, the clip the app asks for when nothing is said. The app's own steps around that (the upload from
 * the caches, `audio_store_url`) need Rust, so they are left to hand tests.
 */

import { describe, it, expect } from 'vitest';
import * as api from '#lib/comfyui/client.ts';
import { runForFiles } from '#lib/comfyui/run.ts';
import { uploadImage } from '#lib/comfyui/upload.ts';
import { comfyVideoFor } from './backend';
import { FAMILY_CAPS, listVideoModels, resolveCompanions, type VideoFamily } from './families';
import { OUTPUT_NODE, buildVideoGraph } from './graphs';
import { videoModel } from '#lib/testing/videoModels.ts';

declare const process: { env: Record<string, string | undefined> };

const LIVE = process.env.HARUSPEX_VIDEO_E2E === '1';
const URL_ = process.env.HARUSPEX_VIDEO_COMFY_URL ?? '';
const ONLY = (process.env.HARUSPEX_VIDEO_FAMILIES ?? '').split(',').filter(Boolean);
const cfg = { baseUrl: URL_, apiKey: '' };
const FULL = process.env.HARUSPEX_VIDEO_FULL === '1';
const wanted = (f: VideoFamily) => LIVE && URL_ && (ONLY.length === 0 || ONLY.includes(f));

/** One second of a 440 Hz tone, as 16 kHz mono WAV: something for S2V to hear. */
function tone(secs = 2): number[] {
	const rate = 16000;
	const n = rate * secs;
	const buf = new DataView(new ArrayBuffer(44 + n * 2));
	const str = (o: number, s: string) =>
		[...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
	str(0, 'RIFF');
	buf.setUint32(4, 36 + n * 2, true);
	str(8, 'WAVEfmt ');
	buf.setUint32(16, 16, true);
	buf.setUint16(20, 1, true);
	buf.setUint16(22, 1, true);
	buf.setUint32(24, rate, true);
	buf.setUint32(28, rate * 2, true);
	buf.setUint16(32, 2, true);
	buf.setUint16(34, 16, true);
	str(36, 'data');
	buf.setUint32(40, n * 2, true);
	for (let i = 0; i < n; i++) {
		buf.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), true);
	}
	return [...new Uint8Array(buf.buffer)];
}

/** A picture already in the server's input folder, as a start or end frame. */
async function aPicture(): Promise<string> {
	const info = (await api.objectInfo(cfg, 'LoadImage')) as {
		LoadImage: { input: { required: { image: [string[]] } } };
	};
	const names = info.LoadImage.input.required.image[0];
	return names.find((n) => /\.png$/i.test(n)) ?? names[0];
}

/** The clip's size: small and short, or the family's defaults with `HARUSPEX_VIDEO_FULL`. */
function size(family: VideoFamily, step: number) {
	const limits = FAMILY_CAPS[family].limits;
	if (FULL) {
		const [width, height] = limits.defaultSize.split('x').map(Number);
		return { width, height, frames: limits.defaultFrames, fps: limits.defaultFps };
	}
	return {
		width: family === 'ltx23' ? 384 : 320,
		height: family === 'ltx23' ? 256 : 192,
		frames: step * 4 + 1,
		fps: limits.fixedFps ?? 24
	};
}

async function clip(
	family: VideoFamily,
	extra: { picture?: boolean; end?: boolean; speech?: boolean }
) {
	const models = await listVideoModels(cfg);
	const model = models.find((m) => m.family === family)?.name;
	expect(model, `a ${family} model on the server`).toBeTruthy();
	const probe = await comfyVideoFor(videoModel('comfyui', { url: URL_, model: model! })).probe();
	expect(probe.detail).toMatch(/^Connected/);
	const { found, missing } = await resolveCompanions(cfg, family);
	expect(missing).toEqual([]);
	const picture = extra.picture ? await aPicture() : undefined;
	const audio = extra.speech
		? await uploadImage(cfg, { name: 'tone.wav', bytes: tone() }, `haruspex-live-tone.wav`)
		: undefined;
	const step = FAMILY_CAPS[family].frameStep;
	const clientId = crypto.randomUUID();
	const graph = buildVideoGraph(family, {
		model: model!,
		companions: found,
		prompt: 'a red fox walking through fresh snow, soft morning light',
		...size(family, step),
		seed: 7,
		startImage: picture,
		endImage: extra.end ? picture : undefined,
		audio,
		prefix: `haruspex/live-${clientId}`
	});
	const started = Date.now();
	const files = await runForFiles(cfg, graph, OUTPUT_NODE, clientId, {}, undefined, {
		deadlineMs: 1_800_000,
		files: 'any'
	});
	const bytes = await api.view(cfg, files[0]);
	console.warn(
		`${family}${FULL ? ' (full size)' : ''}: ${files[0].filename}, ${bytes.length} bytes, ${Math.round((Date.now() - started) / 1000)} s`
	);
	// WebM's EBML header.
	expect([...bytes.slice(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
}

describe('ComfyUI video, live', () => {
	(wanted('wan22_ti2v_5b') ? it : it.skip)(
		'Wan 2.2 TI2V 5B from a prompt and from a picture',
		async () => {
			await clip('wan22_ti2v_5b', {});
			await clip('wan22_ti2v_5b', { picture: true });
		},
		1_800_000
	);
	(wanted('wan22_i2v_14b') ? it : it.skip)(
		'Wan 2.2 I2V 14B from a picture, and to an end picture',
		async () => {
			await clip('wan22_i2v_14b', { picture: true });
			await clip('wan22_i2v_14b', { picture: true, end: true });
		},
		3_600_000
	);
	(wanted('wan22_s2v') ? it : it.skip)(
		'Wan 2.2 S2V makes the person in a picture speak',
		() => clip('wan22_s2v', { picture: true, speech: true }),
		1_800_000
	);
	(wanted('ltx23') ? it : it.skip)(
		'LTX-2.3 from a prompt and from a picture, with sound',
		async () => {
			await clip('ltx23', {});
			await clip('ltx23', { picture: true });
		},
		3_600_000
	);
});
