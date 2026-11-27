/**
 * OpenRouter's image models as the image backend: `POST /v1/images`, one
 * picture per request, paid for from the key the entry names.
 *
 * Calls go through `#lib/openrouterCalls.ts`. The entry's `url` is unused;
 * every entry goes to OpenRouter.
 *
 * A model draws at its own sizes (`./adapter.ts`), so the picture that comes
 * back is cut and scaled to the size asked for (`image_fit_cover`), which
 * also makes it a PNG. Edits send the pictures as data URLs. Nothing here
 * tiles, masks, extends or upscales, and there is no job to resume: a
 * failed or cancelled request isn't billed.
 */

import { invoke } from '@tauri-apps/api/core';
import { logDebug } from '#lib/debugLog.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { errMessage } from '#lib/utils/error.ts';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import { randomSeed } from '#lib/utils/random.ts';
import { fetchOpenRouterKeyStatus } from '#lib/openrouter.ts';
import {
	fetchWithin,
	jsonOf,
	openRouterHeaders,
	openRouterUrl,
	type MakeError
} from '#lib/openrouterCalls.ts';
import { fromBase64 } from '#lib/image/local/adapter.ts';
import { legacyBackend, registerImageBackendKind } from '#lib/image/registry.ts';
import { entryApiKey } from '#lib/image/entries.ts';
import { toImageResult } from '#lib/image/result.ts';
import type { GenerateOptions, ImageBackend, ProbeResult } from '#lib/image/backend.ts';
import {
	ImageBackendError,
	type ImageBackendCapabilities,
	type ImageInput,
	type ImageModelEntry,
	type ImageRequest,
	type ImageResult
} from '#lib/image/types.ts';
import {
	buildImageBody,
	capabilitiesOf,
	costOf,
	drawsPictures,
	formatUsd,
	mimeOf,
	modelOptions,
	parseImageModels,
	picturesFrom,
	priceLine,
	type OpenRouterImageModel
} from '#lib/image/openrouter/adapter.ts';

/** A picture from a slow model, and the queue in front of it. */
const GENERATE_TIMEOUT_MS = 300_000;
/** The model list and a price lookup. */
const LIST_TIMEOUT_MS = 20_000;
/** How long the model list is kept before it is asked for again. */
const LIST_TTL_MS = 60 * 60 * 1000;

/** Some providers take a seed only below 2³¹. */
const SEED_LIMIT = 2 ** 31;

/** Recorded as the sampler: OpenRouter's providers don't say theirs. */
const PROVIDER_SAMPLER = { name: 'provider', steps: 0, cfg: 0 };

const NO_TILING = 'OpenRouter cannot make tiling textures, so the edges may not wrap.';

/**
 * Said when a transparent request came back with no transparent pixel: the
 * model lists a transparent background, but its provider drew a solid one.
 */
export const TRANSPARENCY_LOST =
	'OpenRouter returned it with a solid background although a transparent one was asked for.';

let listed: { at: number; models: Promise<OpenRouterImageModel[]> } | null = null;

/** Test-only: forget the model list. */
export function _resetForTests(): void {
	listed = null;
}

/** The image layer's error, for the shared calls. */
const make: MakeError = (kind, message, opts) => new ImageBackendError(kind, message, opts);

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
	return jsonOf(
		await fetchWithin(
			LIST_TIMEOUT_MS,
			openRouterUrl(path),
			{ headers: openRouterHeaders() },
			make,
			signal
		),
		make,
		'request'
	);
}

/** OpenRouter's image models, asked once an hour. */
export function imageModels(signal?: AbortSignal): Promise<OpenRouterImageModel[]> {
	if (listed && Date.now() - listed.at < LIST_TTL_MS) return listed.models;
	const models = getJson('/v1/images/models', signal).then(parseImageModels);
	listed = { at: Date.now(), models };
	// A failed list is asked for again next time.
	void models.catch(() => {
		if (listed?.models === models) listed = null;
	});
	return models;
}

/** `id`'s price in a few words, or null when it can't be had. */
async function priceOf(id: string, signal?: AbortSignal): Promise<string | null> {
	try {
		return priceLine(await getJson(`/v1/images/models/${id}/endpoints`, signal));
	} catch {
		return null;
	}
}

/**
 * The OpenRouter key Settings → Inference uses, whether or not OpenRouter is
 * the chosen option now: what a new OpenRouter image model starts with.
 */
export function inferenceOpenRouterKeyId(): string | null {
	const inf = getSettings().inferenceBackend;
	if (inf.remoteBackendKind === 'openrouter') return inf.remoteApiKeyId ?? null;
	return inf.remoteProfiles?.openrouter?.remoteApiKeyId ?? null;
}

/** A picture to edit as a data URL. */
async function dataUrlOf(input: ImageInput): Promise<string> {
	let bytes: Uint8Array;
	if ('bytes' in input) {
		bytes = new Uint8Array(input.bytes);
	} else {
		try {
			bytes = new Uint8Array(await invoke<ArrayBuffer>('image_read_bytes', { hash: input.hash }));
		} catch {
			throw new ImageBackendError('rejected', 'That picture is no longer in the image cache.');
		}
	}
	return `data:${mimeOf(bytes)};base64,${bytesToBase64(bytes)}`;
}

/** `entry`'s model from the list, or why it can't draw. */
async function chosenModel(
	entry: ImageModelEntry,
	signal?: AbortSignal
): Promise<OpenRouterImageModel> {
	const id = entry.model.trim();
	if (!id) {
		throw new ImageBackendError(
			'unconfigured',
			'No OpenRouter image model is chosen — Settings → Image generation.'
		);
	}
	const model = (await imageModels(signal)).find((m) => m.id === id);
	if (!model) {
		throw new ImageBackendError(
			'unconfigured',
			`OpenRouter no longer lists ${id} — Settings → Image generation.`
		);
	}
	return model;
}

/** The key `entry` sends, or why it has none. */
async function keyOf(entry: ImageModelEntry): Promise<string> {
	const key = (await entryApiKey(entry)).trim();
	if (!key) {
		throw new ImageBackendError(
			'unconfigured',
			'No OpenRouter API key is chosen — Settings → Image generation.'
		);
	}
	return key;
}

/** `TRANSPARENCY_LOST` when `png` has no pixel short of opaque; undefined otherwise or unsure. */
async function lostTransparency(png: Uint8Array): Promise<string | undefined> {
	try {
		const clear = await invoke<number>('image_transparent_fraction', { bytes: Array.from(png) });
		return clear > 0 ? undefined : TRANSPARENCY_LOST;
	} catch {
		return undefined;
	}
}

/** Refuse what no OpenRouter model does, before anything is paid for. */
function refuseUnsupported(req: ImageRequest): void {
	if (req.inpaint) {
		throw new ImageBackendError('unconfigured', 'OpenRouter models cannot extend pictures.');
	}
	if (req.edit?.mask) {
		throw new ImageBackendError(
			'unconfigured',
			'OpenRouter models cannot change only part of a picture.'
		);
	}
}

/** `POST /v1/images`: the answer's pictures, as base64. */
async function draw(
	apiKey: string,
	model: OpenRouterImageModel,
	body: Record<string, unknown>,
	signal?: AbortSignal
): Promise<string[]> {
	const payload = await jsonOf(
		await fetchWithin(
			GENERATE_TIMEOUT_MS,
			openRouterUrl('/v1/images'),
			{ method: 'POST', headers: openRouterHeaders(apiKey, true), body: JSON.stringify(body) },
			make,
			signal
		),
		make,
		'picture'
	);
	const pictures = picturesFrom(payload);
	if (pictures.length === 0) {
		throw new ImageBackendError('rejected', 'OpenRouter returned no picture.');
	}
	const cost = costOf(payload);
	if (cost !== null) logDebug('image', `openrouter: ${model.id} cost ${formatUsd(cost)}`);
	return pictures;
}

/** Each picture cut and scaled to `width` × `height`, as a PNG: what every backend returns. */
async function fitted(pictures: string[], width: number, height: number): Promise<Uint8Array[]> {
	const images: Uint8Array[] = [];
	for (const b64 of pictures) {
		try {
			const png = await invoke<number[]>('image_fit_cover', {
				bytes: Array.from(fromBase64(b64)),
				width,
				height
			});
			images.push(new Uint8Array(png));
		} catch (e) {
			throw new ImageBackendError(
				'rejected',
				`OpenRouter's picture could not be read: ${errMessage(e)}`
			);
		}
	}
	return images;
}

/** One picture from `entry`'s model. */
async function generateWith(
	entry: ImageModelEntry,
	req: ImageRequest,
	opts: GenerateOptions = {}
): Promise<ImageResult> {
	refuseUnsupported(req);
	const model = await chosenModel(entry, opts.signal);
	const caps = capabilitiesOf(model);
	if (req.edit && !caps.edit) {
		throw new ImageBackendError('unconfigured', `${model.name} on OpenRouter can't edit pictures.`);
	}
	const apiKey = await keyOf(entry);
	const references = req.edit ? await Promise.all(req.edit.images.map(dataUrlOf)) : [];
	const seed = (req.seed ?? randomSeed()) % SEED_LIMIT;
	const transparent = !!req.transparent && caps.transparency;
	const body = buildImageBody(model, {
		model: model.id,
		prompt: req.prompt,
		width: req.width,
		height: req.height,
		seed,
		transparent,
		references
	});

	opts.onProgress?.({ phase: 'running' });
	const started = Date.now();
	const pictures = await draw(apiKey, model, body, opts.signal);
	opts.onProgress?.({ phase: 'downloading' });
	const images = await fitted(pictures, req.width, req.height);
	const transparencyFailed = transparent ? await lostTransparency(images[0]) : undefined;

	return toImageResult(images, {
		backend: 'openrouter',
		width: req.width,
		height: req.height,
		seed,
		model: model.id,
		sampler: PROVIDER_SAMPLER,
		started,
		seamFailed: req.seamless ? NO_TILING : undefined,
		transparencyFailed
	});
}

async function probeEntry(entry: ImageModelEntry): Promise<ProbeResult> {
	let models: OpenRouterImageModel[];
	try {
		models = await imageModels();
	} catch (e) {
		return { ok: false, detail: errMessage(e) };
	}
	const options = modelOptions(models);
	const key = (await entryApiKey(entry)).trim();
	if (!key) {
		return {
			ok: false,
			detail: 'Choose an OpenRouter API key.',
			models: options
		};
	}
	try {
		await fetchOpenRouterKeyStatus(key);
	} catch (e) {
		return { ok: false, detail: errMessage(e), models: options };
	}
	const id = entry.model.trim();
	const model = models.find((m) => m.id === id);
	if (!id) return { ok: false, detail: 'Choose a model.', models: options };
	if (!model || !drawsPictures(model)) {
		return { ok: false, detail: `OpenRouter no longer lists ${id}.`, models: options };
	}
	const price = await priceOf(model.id);
	return {
		ok: true,
		detail: price ? `Connected — ${price}.` : 'Connected.',
		models: options
	};
}

/** The backend for one OpenRouter entry: its key and model. */
function openRouterFor(entry: ImageModelEntry): ImageBackend {
	return {
		kind: 'openrouter',

		async capabilities(): Promise<ImageBackendCapabilities> {
			const model = (await imageModels().catch(() => [])).find((m) => m.id === entry.model.trim());
			return model
				? capabilitiesOf(model)
				: { transparency: false, seamlessTiling: false, loras: false, maxLoras: 0 };
		},

		probe: () => probeEntry(entry),

		generate: (req, opts) => generateWith(entry, req, opts)
	};
}

registerImageBackendKind('openrouter', openRouterFor);

/** The first OpenRouter image model as a backend, read again on every call. */
export const openRouterImageBackend = legacyBackend('openrouter');
