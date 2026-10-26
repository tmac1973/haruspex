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
import { sleep } from '#lib/utils/async.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { registerImageBackend } from '#lib/image/registry.ts';
import type { GenerateOptions, ImageBackend, ProbeResult } from '#lib/image/backend.ts';
import {
	ImageBackendError,
	type ImageBackendCapabilities,
	type ImageInput,
	type ImageRequest,
	type ImageResult
} from '#lib/image/types.ts';
import type { UploadFile } from '#lib/ipc/gen/UploadFile.ts';
import { fromBase64, toBase64 } from '#lib/image/local/adapter.ts';
import { FAMILY_SAMPLER, familyOfId } from '#lib/image/local/adapter.ts';
import { transparentStart, type SdFamily } from '#lib/image/sdcpp.ts';
import type { LemonadeModel } from '#lib/ipc/gen/LemonadeModel.ts';
import {
	ROUTES,
	UPSCALER,
	bareName,
	buildEditFields,
	buildGeneration,
	imagesFrom,
	randomSeed,
	readServer,
	type ServerState
} from '#lib/image/lemonade/adapter.ts';
import { lemonadeConfig, lemonadeJson, lemonadeUpload } from '#lib/image/lemonade/client.ts';

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

/** Pictures one Qwen edit combines here, as on the bundled engine. */
const MAX_EDIT_IMAGES = 3;

function upload(input: ImageInput): UploadFile {
	return {
		field: 'image[]',
		filename: input.name,
		hash: 'hash' in input ? input.hash : null,
		cache: 'hash' in input ? 'image' : null,
		bytes: 'bytes' in input ? input.bytes : null
	};
}

/** An edit through `/api/v1/images/edits`; throws when the model can't edit. */
async function edit(
	req: ImageRequest,
	model: LemonadeModel,
	sampler: { name: string; steps: number; cfg: number },
	seed: number,
	signal?: AbortSignal
): Promise<Uint8Array[]> {
	const state = await serverState(signal);
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
		lemonadeConfig(),
		{ path: ROUTES.edits, fields, timeoutMs: GENERATE_TIMEOUT_MS },
		req.edit!.images.map(upload),
		signal
	);
	return imagesFrom(payload);
}

/** An edit's or upscale's picture as base64, read from the image cache when it is there. */
async function base64Of(input: ImageInput): Promise<string> {
	if ('bytes' in input) return toBase64(new Uint8Array(input.bytes));
	try {
		return toBase64(
			new Uint8Array(await invoke<ArrayBuffer>('image_read_bytes', { hash: input.hash }))
		);
	} catch {
		throw new ImageBackendError('rejected', 'That picture is no longer in the image cache.');
	}
}

/** A model's name for a dropdown: its description up to the dash. */
export function modelLabel(m: LemonadeModel): string {
	return m.description.split(' — ')[0];
}

/** Said of every tiling request: see the top of this file. */
const NO_TILING = 'Lemonade cannot make tiling textures, so the edges may not wrap.';

export const lemonadeBackend: ImageBackend = {
	kind: 'lemonade',

	async capabilities(): Promise<ImageBackendCapabilities> {
		// Both families draw transparent images, as on the bundled engine.
		// Neither tiles here, and LoRAs are not offered. Editing and upscaling
		// depend on what is installed, so the server is asked.
		const ok = familyOfId(modelId()) !== null;
		const model = (await lemonadeCatalogue().catch(() => [])).find((m) => m.id === modelId());
		const state = ok ? await serverState().catch(() => null) : null;
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

	async generate(req: ImageRequest, opts: GenerateOptions = {}): Promise<ImageResult> {
		const { id, family, model } = await chosen();

		// Say so when the server has to load it first: that is most of a minute.
		const loaded = await serverState(opts.signal)
			.then((s) => s.loadedImage)
			.catch(() => null);
		opts.onProgress?.({ phase: loaded === bareName(model.name) ? 'running' : 'loading' });

		const sampler = req.sampler ?? { ...FAMILY_SAMPLER[family] };
		const seed = req.seed ?? randomSeed();
		const started = Date.now();
		let images: Uint8Array[];
		if (req.edit) {
			images = await edit(req, model, sampler, seed, opts.signal);
		} else {
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
			images = await draw(body, opts.signal);
		}
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
	},

	/**
	 * Four times larger with Lemonade's Real-ESRGAN, RGB as it returns it;
	 * `image_store_upscaled` puts the alpha back.
	 */
	async upscale(input: ImageInput, opts: GenerateOptions = {}): Promise<Uint8Array> {
		opts.onProgress?.({ phase: 'running', detail: 'Upscaling' });
		const payload = await lemonadeJson(
			lemonadeConfig(),
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
};

registerImageBackend(lemonadeBackend);
