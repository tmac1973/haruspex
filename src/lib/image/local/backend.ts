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
import {
	DEFAULT_SAMPLER,
	FIXTURE,
	ROUTES,
	buildRequest,
	declaredCapabilities,
	imagesFrom,
	seedFrom
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
 * The weights this backend is configured to load.
 *
 * A catalogue id WINS over a hand-typed path when both are set, which is the
 * precedence the settings type fixed: the id names something Haruspex
 * downloaded and knows the licence of, the path is the escape hatch for a file
 * it knows nothing about. An id that resolves to nothing on disk falls back to
 * the path rather than failing — a half-finished download should not make a
 * working custom model unreachable.
 */
async function modelPath(): Promise<string> {
	const id = (getSettings().imageLocalModelId ?? '').trim();
	if (id) {
		const resolved = await invoke<string | null>('image_model_path', { id }).catch(() => null);
		if (resolved) return resolved;
	}
	return (getSettings().imageLocalModelPath ?? '').trim();
}

/**
 * Start the engine unless it is already serving the right weights.
 *
 * The Rust side is the authority on both questions — it is idempotent for the
 * same model and restarts for a different one — so this does not try to
 * decide, it just asks.
 */
async function ensureRunning(): Promise<void> {
	const path = await modelPath();
	if (!path) {
		throw new ImageBackendError('unconfigured', 'No image model is configured — Settings → Image.');
	}
	try {
		await invoke('image_engine_start', { modelPath: path });
	} catch (e) {
		// The command returns a typed reason; the ones the user can act on are
		// configuration, the rest are the engine failing to come up.
		const kind = (e as { kind?: string })?.kind;
		const detail = (e as { detail?: string })?.detail ?? String(e);
		if (kind === 'NoModel' || kind === 'ModelMissing' || kind === 'SidecarMissing') {
			throw new ImageBackendError('unconfigured', detail || 'The image engine is not set up.');
		}
		throw new ImageBackendError('unreachable', detail || 'The image engine did not start.');
	}
}

/**
 * One HTTP call to the engine, made from Rust.
 *
 * The ComfyUI client uses `fetch` because it talks to a server the user runs,
 * whose CORS policy is the user's business. This one talks to a process we
 * spawned on loopback — and a webview `fetch` sends an `Origin` header that
 * a bare HTTP server has no reason to accept. Going through Rust means no
 * origin, no preflight, and no CORS configuration for anyone to get wrong.
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
		return declaredCapabilities();
	},

	async probe() {
		const st = await engineStatus();
		if (!st.available) {
			return {
				ok: false,
				detail: 'No image engine is bundled for this platform.'
			};
		}
		const path = await modelPath();
		if (!path) {
			return { ok: false, detail: 'No model is selected — Settings → Image.' };
		}
		if (st.status.type === 'Ready') {
			return { ok: true, detail: `Running, ${st.model ?? path}.` };
		}
		if (st.status.type === 'Error') {
			return { ok: false, detail: st.status.message ?? 'The engine reported an error.' };
		}
		// Not an error: the engine starts on demand, and saying so is more
		// useful than a red cross for a thing that has not been asked to run.
		return { ok: true, detail: `Ready to start (${FIXTURE.version}).` };
	},

	async generate(req: ImageRequest, opts: GenerateOptions = {}): Promise<ImageResult> {
		await ensureRunning();
		opts.onProgress?.({ phase: 'running' });

		const caps = declaredCapabilities();
		const { route, body } = buildRequest(req, caps);
		const started = Date.now();
		const payload = await call(route, body, opts.signal);

		const images = imagesFrom(payload);
		if (images.length === 0) {
			throw new ImageBackendError('rejected', `The image engine returned no image from ${route}.`);
		}

		const sampler = req.sampler ?? { ...DEFAULT_SAMPLER };
		return {
			images: images.map((bytes) => ({
				bytes,
				mimeType: 'image/png',
				width: req.width,
				height: req.height
			})),
			meta: {
				seed: seedFrom(payload, req.seed ?? -1),
				model: await modelPath(),
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
