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

/** Mirrors `image_engine::IMAGE_PORT`. Used by the UI, not to build URLs —
 *  the Rust side owns the address. */
export const LOCAL_PORT = 8767;

/** One generation, weights already loaded. Startup has its own budget. */
const GENERATE_TIMEOUT_MS = 600_000;

interface EngineStatus {
	status: { type: string; message?: string };
	model: string | null;
	available: boolean;
}

async function engineStatus(): Promise<EngineStatus> {
	return await invoke<EngineStatus>('image_engine_status');
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
		const msg = e instanceof Error ? e.message : String(e);
		throw new ImageBackendError('unreachable', `The image engine failed ${path} — ${msg}`);
	}
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
		let prompt = req.prompt;
		let clearStart: string | undefined;
		if (req.transparent) {
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

		const images = imagesFrom(payload);
		if (images.length === 0) {
			throw new ImageBackendError('rejected', `The image engine returned no image from ${route}.`);
		}

		return {
			images: images.map((bytes) => ({
				bytes,
				mimeType: 'image/png',
				width: req.width,
				height: req.height
			})),
			meta: {
				seed: seedFrom(payload, req.seed ?? -1),
				model: modelId(),
				backend: 'local',
				sampler,
				// Echoed as RESOLVED: this build takes LoRAs from a directory
				// rather than per request, so nothing was applied here and
				// saying otherwise would put a lie in the anchor recipe.
				loras: [],
				durationMs: Date.now() - started
			}
		};
	}
};

export { ROUTES };
registerImageBackend(localBackend);
