/**
 * The bundled stable-diffusion.cpp backend.
 *
 * Unlike ComfyUI, which the user runs, this one is a process Haruspex owns:
 * `generate` starts it if it is not already up, and nothing starts at boot.
 * A user who never selects this backend never pays for it.
 *
 * The HTTP call goes through the Rust side rather than `fetch`, which is a
 * departure from the ComfyUI client and a deliberate one — see the comment on
 * `call` below.
 */

import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '$lib/utils/error';
import { sleep } from '$lib/utils/async';
import type { ImageEngineStatus } from '$lib/ipc/gen/ImageEngineStatus';
import { getSettings } from '$lib/stores/settings';
import { registerImageBackend } from '../registry';
import type { ImageBackend, GenerateOptions } from '../backend';
import {
	ImageBackendError,
	type ImageBackendCapabilities,
	type ImageRequest,
	type ImageResult
} from '../types';
import { mingTransparent, qwen21Transparent } from '../comfyui/templates';
import {
	FAMILY_SAMPLER,
	FIXTURE,
	ROUTES,
	buildRequest,
	declaredCapabilities,
	familyOfId,
	imagesFrom,
	seedFrom,
	toBase64,
	type LocalFamily
} from './adapter';

/** One generation, weights already loaded. Startup has its own budget. */
const GENERATE_TIMEOUT_MS = 600_000;

async function engineStatus(): Promise<ImageEngineStatus> {
	return await invoke<ImageEngineStatus>('image_engine_status');
}

/**
 * The catalogue entry this backend is configured to run.
 *
 * Catalogue only: each entry is a set of files with known roles and a known
 * licence. The hand-typed single-file path the SD catalogue allowed has no
 * meaning for a model that needs four files.
 */
function modelId(): string {
	return (getSettings().imageLocalModelId ?? '').trim();
}

/**
 * Start the engine unless it is already serving the right weights.
 *
 * The Rust side is the authority on both questions — it is idempotent for the
 * same model and restarts for a different one — so this does not try to
 * decide, it just asks.
 */
/**
 * A start failure the user can act on, in words; null for the rest.
 *
 * The Rust error's `detail` is a fragment — for a missing engine it was just
 * "sd-server" — so each kind gets its own sentence and the next step.
 */
export function engineSetupMessage(kind: string | undefined, detail: string): string | null {
	switch (kind) {
		case 'NoModel':
			return 'No image model is configured — Settings → Image.';
		case 'ModelMissing':
			return `The image model is not on disk (${detail}) — download it again in Settings → Image.`;
		case 'SidecarMissing':
			return (
				`The bundled image engine is missing (${detail}). Reinstall Haruspex, or in a ` +
				'development checkout run ./scripts/fetch-sdcpp.sh.'
			);
		default:
			return null;
	}
}

async function ensureRunning(): Promise<LocalFamily> {
	const id = modelId();
	const family = familyOfId(id);
	if (!family) {
		throw new ImageBackendError('unconfigured', 'No image model is configured — Settings → Image.');
	}
	try {
		await invoke('image_engine_start', { modelId: id });
		return family;
	} catch (e) {
		// The command returns a typed reason; the ones the user can act on are
		// configuration, the rest are the engine failing to come up.
		const kind = (e as { kind?: string })?.kind;
		const detail = (e as { detail?: string })?.detail ?? String(e);
		const setUp = engineSetupMessage(kind, detail);
		if (setUp) throw new ImageBackendError('unconfigured', setUp);
		throw new ImageBackendError('unreachable', detail || 'The image engine did not start.');
	}
}

/**
 * One HTTP call to the engine, made from Rust.
 *
 * Through Rust, like the ComfyUI client: a webview `fetch` sends an `Origin`
 * header that a bare HTTP server has no reason to accept. Going through Rust
 * means no origin, no preflight, and no CORS configuration to get wrong.
 */
async function call(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
	for (let attempt = 1; ; attempt++) {
		if (signal?.aborted) throw new ImageBackendError('cancelled', 'Generation cancelled.');
		try {
			const text = await invoke<string>('image_engine_request', {
				path,
				body: JSON.stringify(body),
				timeoutMs: GENERATE_TIMEOUT_MS
			});
			return JSON.parse(text);
		} catch (e) {
			if (signal?.aborted) throw new ImageBackendError('cancelled', 'Generation cancelled.');
			const msg = errMessage(e);
			if (EMPTY_RESULT.test(msg) && attempt < EMPTY_RESULT_ATTEMPTS) {
				await sleep(EMPTY_RESULT_RETRY_MS);
				continue;
			}
			throw new ImageBackendError('unreachable', `The image engine failed ${path} — ${msg}`);
		}
	}
}

/**
 * sd-server sometimes answers a 1024² Ming img2img with a 500 "generate_image
 * returned no results" in a fifth of a second, before sampling starts, and the
 * identical request succeeds straight after (2 of 9 in a row on 2026-10-05).
 * It cost a whole asset run its style anchor, so it is retried, briefly.
 */
const EMPTY_RESULT = /generate_image returned no results/;
const EMPTY_RESULT_ATTEMPTS = 3;
const EMPTY_RESULT_RETRY_MS = 1000;

/**
 * Make a texture tile: roll it by half so its seams cross in the middle, repaint
 * a band over them, and keep everything else to the byte. The edges of the
 * result are the original's middle, so they wrap by construction; the repaint
 * only has to hide the cross. Phase 28 measured the band and strength.
 */
async function tile(
	base: Uint8Array,
	req: ImageRequest & { sampler: { name: string; steps: number; cfg: number }; seed: number },
	signal?: AbortSignal
): Promise<Uint8Array> {
	const inputs = await invoke<{ rolled: number[]; mask: number[] }>('image_seam_inputs', {
		bytes: Array.from(base)
	});
	const { route, body } = buildRequest({
		...req,
		// A different seed from the base: the same one redraws the same layout
		// on top of a rolled one.
		seed: req.seed >= 0 ? req.seed + 1 : -1,
		repaint: {
			image: toBase64(new Uint8Array(inputs.rolled)),
			mask: toBase64(new Uint8Array(inputs.mask))
		}
	});
	const repainted = imagesFrom(await call(route, body, signal));
	if (repainted.length === 0) {
		throw new ImageBackendError(
			'rejected',
			'The image engine returned no image for the seam pass.'
		);
	}
	const out = await invoke<number[]>('image_seam_finish', {
		rolled: inputs.rolled,
		repainted: Array.from(repainted[0])
	});
	return new Uint8Array(out);
}

export const localBackend: ImageBackend = {
	kind: 'local',

	async capabilities(): Promise<ImageBackendCapabilities> {
		return declaredCapabilities(familyOfId(modelId()));
	},

	async probe() {
		const st = await engineStatus();
		if (!st.available) {
			return {
				ok: false,
				detail: 'No image engine is bundled for this platform.'
			};
		}
		const id = modelId();
		if (!familyOfId(id)) {
			return { ok: false, detail: 'No model is selected — Settings → Image.' };
		}
		if (st.status.type === 'Ready') {
			return { ok: true, detail: `Running, ${st.model ?? id}.` };
		}
		if (st.status.type === 'Error') {
			return { ok: false, detail: st.status.message ?? 'The engine reported an error.' };
		}
		// Not an error: the engine starts on demand, and saying so is more
		// useful than a red cross for a thing that has not been asked to run.
		return { ok: true, detail: `Ready to start (${FIXTURE.version}).` };
	},

	async generate(req: ImageRequest, opts: GenerateOptions = {}): Promise<ImageResult> {
		const family = await ensureRunning();
		opts.onProgress?.({ phase: 'running' });

		const sampler = req.sampler ?? { ...FAMILY_SAMPLER[family] };
		// Transparency as each family makes it: Ming from a clear canvas AND its
		// RGBA phrase (neither alone works), Qwen from its phrase alone.
		// A tiling texture is opaque by nature; asked for both, it tiles.
		const seamless = Boolean(req.seamless);
		let prompt = req.prompt;
		let clearStart: string | undefined;
		if (req.transparent && !seamless) {
			if (family === 'ming') {
				prompt = mingTransparent(req.prompt);
				const canvas = await invoke<number[]>('image_clear_canvas', {
					width: req.width,
					height: req.height
				});
				clearStart = toBase64(new Uint8Array(canvas));
			} else {
				prompt = qwen21Transparent(req.prompt);
			}
		}
		const { route, body } = buildRequest({ ...req, prompt, sampler, clearStart });
		const started = Date.now();
		const payload = await call(route, body, opts.signal);

		let images = imagesFrom(payload);
		if (images.length === 0) {
			throw new ImageBackendError('rejected', `The image engine returned no image from ${route}.`);
		}
		const seed = seedFrom(payload, req.seed ?? -1);
		let seamFailed: string | undefined;
		if (seamless) {
			opts.onProgress?.({ phase: 'running', detail: 'Repainting the seams' });
			try {
				images = [await tile(images[0], { ...req, prompt, sampler, seed }, opts.signal)];
			} catch (e) {
				if (opts.signal?.aborted) throw e;
				// Keep the texture the engine did draw. Losing it over the seam
				// pass cost a run all nine of its textures.
				seamFailed = errMessage(e);
			}
		}

		return {
			images: images.map((bytes) => ({
				bytes,
				mimeType: 'image/png',
				width: req.width,
				height: req.height
			})),
			meta: {
				seed,
				model: modelId(),
				backend: 'local',
				sampler,
				// Echoed as RESOLVED: this build takes LoRAs from a directory
				// rather than per request, so nothing was applied here and
				// saying otherwise would put a lie in the anchor recipe.
				loras: [],
				durationMs: Date.now() - started,
				...(seamFailed ? { seamFailed } : {})
			}
		};
	}
};

export { ROUTES };
registerImageBackend(localBackend);
