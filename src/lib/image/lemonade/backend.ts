/**
 * A Lemonade server's sd-cpp recipe as the image backend: the bundled
 * engine's models and its way of drawing, on a server the user keeps.
 *
 * The model is a catalogue id (`imageLemonadeModelId`), installed on the
 * server from Settings → Image (`./install.svelte.ts`) under a fixed name, so
 * every request knows its family and how to make it transparent.
 *
 * It edits with Qwen-Image 2.1 when its vision weights were installed with
 * it (`/api/v1/images/edits`, pictures as file parts), and upscales with
 * Lemonade's own Real-ESRGAN (`/api/v1/images/upscale`) once that is
 * installed; Settings → Image installs both.
 *
 * It does not tile. The seam pass is an img2img from the rolled texture, and
 * the only way to hand sd-server a start image through Lemonade is inside the
 * prompt, where a picture that size crashes it (`adapter.ts`). A seamless
 * request gets the texture untiled, with `seamFailed` saying why, as a seam
 * pass that failed does on the bundled engine.
 */

import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { legacyBackend, registerImageBackendKind } from '#lib/image/registry.ts';
import { entryApiKey } from '#lib/image/legacy.ts';
import type { GenerateOptions, ImageBackend, ProbeResult } from '#lib/image/backend.ts';
import {
	ImageBackendError,
	type ImageBackendCapabilities,
	type ImageInput,
	type ImageModelEntry,
	type ImageRequest,
	type ImageResult
} from '#lib/image/types.ts';
import { fromBase64 } from '#lib/image/local/adapter.ts';
import { FAMILY_SAMPLER, familyOfId } from '#lib/image/local/adapter.ts';
import { base64Of, retryEmptyResult, transparentStart, type SdFamily } from '#lib/image/sdcpp.ts';
import { editUploads, imagesFrom } from '#lib/image/openaiImages.ts';
import { randomSeed } from '#lib/utils/random.ts';
import type { LemonadeModel } from '#lib/ipc/gen/LemonadeModel.ts';
import {
	ROUTES,
	UPSCALER,
	bareName,
	buildEditFields,
	buildGeneration,
	readServer,
	type ServerState
} from '#lib/image/lemonade/adapter.ts';
import {
	lemonadeConfig,
	lemonadeJson,
	lemonadeUpload,
	type LemonadeConfig
} from '#lib/image/lemonade/client.ts';
import { refreshOptions } from '#lib/image/lemonade/options.ts';

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

/** The server's state, from the three calls a probe makes. */
export async function serverState(
	signal?: AbortSignal,
	cfg: LemonadeConfig = lemonadeConfig()
): Promise<ServerState> {
	const [health, systemInfo, models] = await Promise.all([
		lemonadeJson(cfg, { path: ROUTES.health }, signal),
		lemonadeJson(cfg, { path: ROUTES.systemInfo }, signal),
		lemonadeJson(cfg, { path: ROUTES.models }, signal)
	]);
	return readServer(health, systemInfo, models);
}

async function draw(
	cfg: LemonadeConfig,
	body: ReturnType<typeof buildGeneration>,
	signal?: AbortSignal
): Promise<Uint8Array[]> {
	const payload = await retryEmptyResult(
		() =>
			lemonadeJson(
				cfg,
				{ method: 'POST', path: ROUTES.generate, body, timeoutMs: GENERATE_TIMEOUT_MS },
				signal
			),
		signal
	);
	return imagesFrom(payload);
}

/** The configured server and model, or why a generation cannot start. */
async function chosen(
	cfg: LemonadeConfig,
	id: string
): Promise<{ id: string; family: SdFamily; model: LemonadeModel }> {
	if (!cfg.baseUrl) {
		throw new ImageBackendError('unconfigured', 'No Lemonade server is set — Settings → Image.');
	}
	const family = familyOfId(id);
	const model = (await lemonadeCatalogue()).find((m) => m.id === id);
	if (!family || !model) {
		throw new ImageBackendError('unconfigured', 'No image model is chosen — Settings → Image.');
	}
	return { id, family, model };
}

/** Pictures one Qwen edit combines here, as on the bundled engine. */
const MAX_EDIT_IMAGES = 3;

/** An edit through `/api/v1/images/edits`; throws when the model can't edit. */
async function edit(
	cfg: LemonadeConfig,
	req: ImageRequest,
	model: LemonadeModel,
	sampler: { name: string; steps: number; cfg: number },
	seed: number,
	signal?: AbortSignal
): Promise<Uint8Array[]> {
	const state = await serverState(signal, cfg);
	if (!state.edits.has(bareName(model.name))) {
		throw new ImageBackendError(
			'unconfigured',
			`${modelLabel(model)} on Lemonade can't edit — Settings → Image → Add editing.`
		);
	}
	const fields = buildEditFields({
		model: model.name,
		prompt: req.prompt,
		negativePrompt: req.negativePrompt,
		seed,
		width: req.width,
		height: req.height,
		sampler
	});
	const payload = await lemonadeUpload(
		cfg,
		{ path: ROUTES.edits, fields, timeoutMs: GENERATE_TIMEOUT_MS },
		editUploads(req.edit!),
		signal
	);
	return imagesFrom(payload);
}

/** A model's name for a dropdown: its description up to the dash. */
export function modelLabel(m: LemonadeModel): string {
	return m.description.split(' — ')[0];
}

/** Said of every tiling request: see the top of this file. */
const NO_TILING = 'Lemonade cannot make tiling textures, so the edges may not wrap.';

/**
 * Said when Ming's transparent start came back opaque. That start rides in the
 * first `<sd_cpp_extra_args>` block of the prompt, ahead of Lemonade's own; an
 * sd-server that read the last block instead would drop it without a word, and
 * every transparent picture would quietly come back solid.
 */
export const TRANSPARENCY_LOST =
	'Lemonade returned it with a solid background although a transparent one was asked for, ' +
	'so the server may no longer read the settings Haruspex sends. The bundled engine and ' +
	'ComfyUI can make it transparent.';

/** `TRANSPARENCY_LOST` when `png` has no pixel short of opaque; undefined otherwise or unsure. */
async function lostTransparency(png: Uint8Array): Promise<string | undefined> {
	try {
		const clear = await invoke<number>('image_transparent_fraction', { bytes: Array.from(png) });
		if (clear > 0) return undefined;
		console.warn('lemonade: a transparent Ming request came back fully opaque');
		return TRANSPARENCY_LOST;
	} catch {
		return undefined;
	}
}

async function configOf(entry: ImageModelEntry): Promise<LemonadeConfig> {
	return { baseUrl: entry.url.trim(), apiKey: await entryApiKey(entry) };
}

/** The backend for one Lemonade entry: its server, key and catalogue model. */
function lemonadeFor(entry: ImageModelEntry): ImageBackend {
	const modelId = () => entry.model.trim();
	const config = () => configOf(entry);
	return {
		kind: 'lemonade',

		async capabilities(): Promise<ImageBackendCapabilities> {
			// Both families draw transparent images, as on the bundled engine.
			// Neither tiles here, and LoRAs are not offered. Editing and upscaling
			// depend on what is installed, so the server is asked.
			const ok = familyOfId(modelId()) !== null;
			const model = (await lemonadeCatalogue().catch(() => [])).find((m) => m.id === modelId());
			const state = ok ? await serverState(undefined, await config()).catch(() => null) : null;
			const edits = !!state && !!model && state.edits.has(bareName(model.name));
			return {
				transparency: ok,
				seamlessTiling: false,
				loras: false,
				maxLoras: 0,
				edit: edits,
				maxEditImages: edits ? MAX_EDIT_IMAGES : 0,
				upscale: !!state?.upscaler
			};
		},

		async probe(): Promise<ProbeResult> {
			const cfg = await config();
			if (!cfg.baseUrl) {
				return { ok: false, detail: 'No server address — Settings → Image.' };
			}
			let state: ServerState;
			try {
				state = await serverState(undefined, cfg);
			} catch (e) {
				return { ok: false, detail: errMessage(e) };
			}
			const where = [`Lemonade ${state.version}`, state.gpu].filter(Boolean).join(' on ');
			if (!state.sdcpp.usable) {
				return { ok: false, detail: `${where} cannot run stable-diffusion.cpp on this hardware.` };
			}
			// Listed before the model is checked, as ComfyUI's are: "no model is
			// chosen" is exactly when the list is wanted.
			const catalogue = await lemonadeCatalogue();
			const models = catalogue
				.filter((m) => state.downloaded.has(bareName(m.name)))
				.map((m) => ({ name: m.id, label: modelLabel(m) }));
			const model = catalogue.find((m) => m.id === modelId());
			if (!model) {
				return { ok: false, detail: 'No model is chosen — Settings → Image.', models };
			}
			if (!state.downloaded.has(bareName(model.name))) {
				return {
					ok: false,
					detail: `${modelLabel(model)} is not installed on the server — Settings → Image → Install.`,
					models
				};
			}
			return { ok: true, detail: `Connected — ${where}, ${state.sdcpp.backend}.`, models };
		},

		generate: (req, opts) => generateWith(entry, req, opts),

		upscale: (input, opts) => upscaleWith(entry, input, opts)
	};
}

/** One picture from `entry`'s model on its Lemonade server. */
async function generateWith(
	entry: ImageModelEntry,
	req: ImageRequest,
	opts: GenerateOptions = {}
): Promise<ImageResult> {
	const cfg = await configOf(entry);
	const { id, family, model } = await chosen(cfg, entry.model.trim());

	// Say so when the server has to load it first: that is most of a minute.
	const state = await serverState(opts.signal, cfg).catch(() => null);
	const name = bareName(model.name);
	let loaded = state?.loadedImage === name;
	if (state?.stale.has(name)) {
		await refreshOptions(model, loaded, opts.signal, cfg);
		loaded = false;
	}
	opts.onProgress?.({ phase: loaded ? 'running' : 'loading' });

	const sampler = req.sampler ?? { ...FAMILY_SAMPLER[family] };
	const seed = req.seed ?? randomSeed();
	const started = Date.now();
	let images: Uint8Array[];
	let clearStart: string | undefined;
	if (req.edit) {
		images = await edit(cfg, req, model, sampler, seed, opts.signal);
	} else {
		const start = await transparentStart(family, req);
		const prompt = start.prompt;
		clearStart = start.clearStart;
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
		images = await draw(cfg, body, opts.signal);
	}
	if (images.length === 0) {
		throw new ImageBackendError('rejected', 'Lemonade returned no image.');
	}
	const transparencyFailed = clearStart ? await lostTransparency(images[0]) : undefined;

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
			...(req.seamless ? { seamFailed: NO_TILING } : {}),
			...(transparencyFailed ? { transparencyFailed } : {})
		}
	};
}

/**
 * Four times larger with Lemonade's Real-ESRGAN, RGB as it returns it;
 * `image_store_upscaled` puts the alpha back.
 */
async function upscaleWith(
	entry: ImageModelEntry,
	input: ImageInput,
	opts: GenerateOptions = {}
): Promise<Uint8Array> {
	opts.onProgress?.({ phase: 'running', detail: 'Upscaling' });
	const payload = await lemonadeJson(
		await configOf(entry),
		{
			method: 'POST',
			path: ROUTES.upscale,
			body: { model: UPSCALER, image: await base64Of(input) },
			timeoutMs: GENERATE_TIMEOUT_MS
		},
		opts.signal
	);
	const out = (payload as { data?: Array<{ b64_json?: unknown }> })?.data?.[0]?.b64_json;
	if (typeof out !== 'string') {
		throw new ImageBackendError('rejected', 'Lemonade returned no upscaled picture.');
	}
	return fromBase64(out);
}

registerImageBackendKind('lemonade', lemonadeFor);

/** Settings → Image's Lemonade as a backend, for what has no entry of its own yet. */
export const lemonadeBackend = legacyBackend('lemonade');
