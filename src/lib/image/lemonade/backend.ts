/**
 * A Lemonade server's sd-cpp recipe as the image backend: the bundled
 * engine's models and its way of drawing, on a server the user keeps.
 *
 * The model is a catalogue id (`imageLemonadeModelId`), installed on the
 * server from Settings → Image (`./install.svelte.ts`) under a fixed name, so
 * every request knows its family and how to make it transparent.
 *
 * It does not tile. The seam pass is an img2img from the rolled texture, and
 * the only way to hand sd-server a start image through Lemonade is inside the
 * prompt, where a picture that size crashes it (`adapter.ts`). A seamless
 * request gets the texture untiled, with `seamFailed` saying why, as a seam
 * pass that failed does on the bundled engine.
 */

import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { sleep } from '#lib/utils/async.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { registerImageBackend } from '#lib/image/registry.ts';
import type { GenerateOptions, ImageBackend, ProbeResult } from '#lib/image/backend.ts';
import {
	ImageBackendError,
	type ImageBackendCapabilities,
	type ImageRequest,
	type ImageResult
} from '#lib/image/types.ts';
import { FAMILY_SAMPLER, familyOfId } from '#lib/image/local/adapter.ts';
import { transparentStart, type SdFamily } from '#lib/image/sdcpp.ts';
import type { LemonadeModel } from '#lib/ipc/gen/LemonadeModel.ts';
import {
	ROUTES,
	bareName,
	buildGeneration,
	imagesFrom,
	randomSeed,
	readServer,
	type ServerState
} from '#lib/image/lemonade/adapter.ts';
import { lemonadeConfig, lemonadeJson } from '#lib/image/lemonade/client.ts';

/**
 * One generation, plus a model load when another image model is resident:
 * Ming's first load measured 28 s on an R9700 (2026-10-23), and a slow disk
 * or a cold server takes longer.
 */
const GENERATE_TIMEOUT_MS = 900_000;

let catalogue: LemonadeModel[] | null = null;

/** The catalogue, as Lemonade registers it. Asked once: it is compiled in. */
export async function lemonadeCatalogue(): Promise<LemonadeModel[]> {
	catalogue ??= await invoke<LemonadeModel[]>('lemonade_catalogue');
	return catalogue;
}

function modelId(): string {
	return (getSettings().imageLemonadeModelId ?? '').trim();
}

/** The server's state, from the three calls a probe makes. */
export async function serverState(signal?: AbortSignal): Promise<ServerState> {
	const cfg = lemonadeConfig();
	const [health, systemInfo, models] = await Promise.all([
		lemonadeJson(cfg, { path: ROUTES.health }, signal),
		lemonadeJson(cfg, { path: ROUTES.systemInfo }, signal),
		lemonadeJson(cfg, { path: ROUTES.models }, signal)
	]);
	return readServer(health, systemInfo, models);
}

/**
 * sd-server sometimes answers a 1024² Ming img2img with "generate_image
 * returned no results" before sampling starts, and the identical request
 * succeeds straight after — measured on the bundled engine, whose build this
 * is. Retried, briefly, as it is there.
 */
const EMPTY_RESULT = /generate_image returned no results/;
const EMPTY_RESULT_ATTEMPTS = 3;
const EMPTY_RESULT_RETRY_MS = 1000;

async function draw(
	body: ReturnType<typeof buildGeneration>,
	signal?: AbortSignal
): Promise<Uint8Array[]> {
	for (let attempt = 1; ; attempt++) {
		try {
			const payload = await lemonadeJson(
				lemonadeConfig(),
				{ method: 'POST', path: ROUTES.generate, body, timeoutMs: GENERATE_TIMEOUT_MS },
				signal
			);
			return imagesFrom(payload);
		} catch (e) {
			if (EMPTY_RESULT.test(errMessage(e)) && attempt < EMPTY_RESULT_ATTEMPTS) {
				await sleep(EMPTY_RESULT_RETRY_MS);
				continue;
			}
			throw e;
		}
	}
}

/** The configured server and model, or why a generation cannot start. */
async function chosen(): Promise<{ id: string; family: SdFamily; model: LemonadeModel }> {
	if (!lemonadeConfig().baseUrl) {
		throw new ImageBackendError('unconfigured', 'No Lemonade server is set — Settings → Image.');
	}
	const id = modelId();
	const family = familyOfId(id);
	const model = (await lemonadeCatalogue()).find((m) => m.id === id);
	if (!family || !model) {
		throw new ImageBackendError('unconfigured', 'No image model is chosen — Settings → Image.');
	}
	return { id, family, model };
}

/** Said of every tiling request: see the top of this file. */
const NO_TILING = 'Lemonade cannot make tiling textures, so the edges may not wrap.';

export const lemonadeBackend: ImageBackend = {
	kind: 'lemonade',

	async capabilities(): Promise<ImageBackendCapabilities> {
		// Both families draw transparent images, as on the bundled engine.
		// Neither tiles here, and LoRAs are not offered.
		const ok = familyOfId(modelId()) !== null;
		return { transparency: ok, seamlessTiling: false, loras: false, maxLoras: 0 };
	},

	async probe(): Promise<ProbeResult> {
		if (!lemonadeConfig().baseUrl) {
			return { ok: false, detail: 'No server address — Settings → Image.' };
		}
		let state: ServerState;
		try {
			state = await serverState();
		} catch (e) {
			return { ok: false, detail: errMessage(e) };
		}
		const where = [`Lemonade ${state.version}`, state.gpu].filter(Boolean).join(' on ');
		if (!state.sdcpp.usable) {
			return { ok: false, detail: `${where} cannot run stable-diffusion.cpp on this hardware.` };
		}
		const model = (await lemonadeCatalogue()).find((m) => m.id === modelId());
		if (!model) return { ok: false, detail: `${where}. No model is chosen — Settings → Image.` };
		if (!state.downloaded.has(bareName(model.name))) {
			return { ok: false, detail: `${where}. The model is not installed — Settings → Image.` };
		}
		return { ok: true, detail: `${where}, ${state.sdcpp.backend}.` };
	},

	async generate(req: ImageRequest, opts: GenerateOptions = {}): Promise<ImageResult> {
		const { id, family, model } = await chosen();

		// Say so when the server has to load it first: that is most of a minute.
		const loaded = await serverState(opts.signal)
			.then((s) => s.loadedImage)
			.catch(() => null);
		opts.onProgress?.({ phase: loaded === bareName(model.name) ? 'running' : 'loading' });

		const sampler = req.sampler ?? { ...FAMILY_SAMPLER[family] };
		const seed = req.seed ?? randomSeed();
		const { prompt, clearStart } = await transparentStart(family, req);
		const body = buildGeneration({
			model: model.name,
			prompt,
			negativePrompt: req.negativePrompt,
			seed,
			width: req.width,
			height: req.height,
			sampler,
			clearStart
		});
		const started = Date.now();
		const images = await draw(body, opts.signal);
		if (images.length === 0) {
			throw new ImageBackendError('rejected', 'Lemonade returned no image.');
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
				model: id,
				backend: 'lemonade',
				sampler,
				loras: [],
				durationMs: Date.now() - started,
				...(req.seamless ? { seamFailed: NO_TILING } : {})
			}
		};
	}
};

registerImageBackend(lemonadeBackend);
