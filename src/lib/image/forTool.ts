/**
 * One image for a model's tool call: the configured backend, checked first
 * and explained when it fails.
 *
 * `generateOneImage` is the Settings test button's primitive, and it says
 * nothing when things go wrong: that's fine for a button, but a model told only
 * "rejected" retries the same call or gives up silently. This wraps the
 * backend so a tool can hand the model a sentence it can pass on: what is not
 * set up, what the backend cannot do, why the GPU said no.
 *
 * It takes a whole `ImageRequest`, so the Shell assistant's asset tool can
 * pass the asset job's requests through unchanged (phase 08).
 */
import { resolveImageBackend, type ImageBackend, type ImageJobHandle } from '#lib/image/backend.ts';
import { backendForEntry } from '#lib/image/registry.ts';
import { entryForHandle, firstImageEntry, saveImageCaps } from '#lib/image/entries.ts';
import { errMessage } from '#lib/utils/error.ts';
import {
	ImageBackendError,
	type ImageBackendCapabilities,
	type ImageEdit,
	type ImageInput,
	type ImageProgress,
	type ImageRequest
} from '#lib/image/types.ts';
import { familyOf } from '#lib/image/comfyui/families.ts';
import { toolchestInstance } from '#lib/image/toolchest/backend.ts';

export interface ToolImage {
	bytes: Uint8Array;
	width: number;
	height: number;
	seed: number;
	model: string;
	/** Things the model should know: options dropped, licence limits. */
	notes: string[];
}

export interface ForToolOptions {
	signal?: AbortSignal;
	onProgress?: (p: ImageProgress) => void;
	/** The job's reference, once a queueing server has it; see `GenerateOptions.onHandle`. */
	onHandle?: (handle: ImageJobHandle) => void;
}

/** What a failure from a full GPU looks like, from either engine. */
const GPU_FULL =
	/vae encode compute failed|cannot make enough memory available|out of memory|generate_image returned no results/i;

export const GPU_FULL_SENTENCE =
	'The image engine ran out of GPU memory beside the chat model. A smaller chat model in ' +
	'Settings → Inference → Models, or ComfyUI on another machine in Settings → Image, would leave room.';

export const NO_EDIT_SENTENCE =
	"The image generation in Settings → Image can't edit pictures. Qwen-Image 2.1 can, on the " +
	'bundled engine or Lemonade (Settings → Image → Add editing) or ComfyUI 0.39 or later, and ' +
	'so can FLUX.2 klein 4B (on ComfyUI or llama-toolchest) and Qwen-Image-Edit-2511 (on ComfyUI).';

export const NO_EXTEND_SENTENCE =
	"The image generation in Settings → Image can't grow a picture past its edges. The bundled " +
	'engine and ComfyUI can, with any of their models.';

export const NO_UPSCALE_SENTENCE =
	"The image generation in Settings → Image can't upscale pictures. The bundled engine, " +
	'ComfyUI and Lemonade can, once their upscaler is installed in Settings → Image, and ' +
	'llama-toolchest can with an upscaler instance.';

/**
 * A picture four times larger, from the configured backend, or a sentence the
 * model can pass on when it can't. RGB: the caller restores alpha.
 */
export async function upscaleForTool(
	input: ImageInput,
	opts: ForToolOptions = {}
): Promise<Uint8Array> {
	const backend = resolveImageBackend();
	if (backend.kind === 'none') {
		throw new ImageBackendError(
			'unconfigured',
			'Image generation is not set up. The user can choose a backend in Settings → Image.'
		);
	}
	const caps = await capabilitiesKept(backend);
	if (!caps.upscale || !backend.upscale) {
		throw new ImageBackendError('unconfigured', NO_UPSCALE_SENTENCE);
	}
	try {
		return await backend.upscale(input, {
			signal: opts.signal,
			onProgress: opts.onProgress,
			onHandle: opts.onHandle
		});
	} catch (e) {
		const detail = errMessage(e);
		if (backend.kind === 'local' && GPU_FULL.test(detail)) {
			throw new ImageBackendError('unreachable', `${GPU_FULL_SENTENCE} (${detail})`);
		}
		throw e;
	}
}

/**
 * What the first saved image model's backend can do now, kept with the entry
 * when it differs from what the last probe saw.
 */
async function capabilitiesKept(backend: ImageBackend): Promise<ImageBackendCapabilities> {
	const caps = await backend.capabilities();
	const first = firstImageEntry();
	if (first) saveImageCaps(first.id, caps);
	return caps;
}

/** `entry`'s model (the first saved one by default) can't be used commercially. */
export function nonCommercialModel(entry = firstImageEntry()): boolean {
	if (!entry) return false;
	if (entry.backend === 'local' || entry.backend === 'lemonade') return entry.model === 'qwen21';
	// As the last probe or generation saw it; an unknown recipe isn't flagged.
	if (entry.backend === 'llama-toolchest') {
		return toolchestInstance(entry)?.commercialUse === false;
	}
	const family = familyOf(entry.model);
	return family === 'qwen21' || family === 'qwen21_turbo';
}

/** Throws when the backend can't make this edit. */
function checkEdit(edit: ImageEdit, caps: ImageBackendCapabilities): void {
	if (!caps.edit) throw new ImageBackendError('unconfigured', NO_EDIT_SENTENCE);
	const most = caps.maxEditImages ?? 1;
	if (edit.images.length > most) {
		throw new ImageBackendError(
			'rejected',
			`This model combines at most ${most} picture${most === 1 ? '' : 's'} in one edit.`
		);
	}
}

/**
 * `req` as the backend can take it: throws for an edit or inpaint it can't do,
 * and drops transparency or tiling it can't, saying so in `notes`.
 */
function fitRequest(
	req: ImageRequest,
	caps: ImageBackendCapabilities,
	notes: string[]
): ImageRequest {
	const request: ImageRequest = { ...req };
	if (request.edit) checkEdit(request.edit, caps);
	if (request.inpaint && !caps.inpaint) {
		throw new ImageBackendError('unconfigured', NO_EXTEND_SENTENCE);
	}
	if (request.transparent && !caps.transparency) {
		request.transparent = false;
		notes.push('This backend cannot make transparent images, so the background is solid.');
	}
	if (request.seamless && !caps.seamlessTiling) {
		request.seamless = false;
		notes.push('This backend cannot make tiling textures, so the edges may not wrap.');
	}
	return request;
}

export async function generateForTool(
	req: ImageRequest,
	opts: ForToolOptions = {}
): Promise<ToolImage> {
	const backend = resolveImageBackend();
	if (backend.kind === 'none') {
		throw new ImageBackendError(
			'unconfigured',
			'Image generation is not set up. The user can choose a backend in Settings → Image.'
		);
	}
	const probe = await backend.probe();
	if (!probe.ok) throw new ImageBackendError('unreachable', probe.detail);

	const notes: string[] = [];
	const request = fitRequest(req, await capabilitiesKept(backend), notes);

	let result;
	try {
		result = await backend.generate(request, {
			signal: opts.signal,
			onProgress: opts.onProgress,
			onHandle: opts.onHandle
		});
	} catch (e) {
		const detail = errMessage(e);
		if (backend.kind === 'local' && GPU_FULL.test(detail)) {
			throw new ImageBackendError('unreachable', `${GPU_FULL_SENTENCE} (${detail})`);
		}
		throw e;
	}
	const image = result.images[0];
	if (!image) throw new ImageBackendError('rejected', 'The image backend returned no image.');
	if (result.meta.seamFailed) notes.push(`It does not tile: ${result.meta.seamFailed}`);
	if (result.meta.transparencyFailed) notes.push(result.meta.transparencyFailed);
	if (nonCommercialModel()) {
		notes.push('The model that drew it is licensed for non-commercial use only.');
	}
	return {
		bytes: image.bytes,
		width: image.width,
		height: image.height,
		seed: result.meta.seed,
		model: result.meta.model,
		notes
	};
}

/**
 * A job an earlier run of the app sent (`ForToolOptions.onHandle`), followed
 * to its end on the backend and server it went to.
 */
export async function resumeForTool(
	handle: ImageJobHandle,
	opts: ForToolOptions = {}
): Promise<ToolImage> {
	const entry = entryForHandle(handle);
	const backend = entry ? backendForEntry(entry) : undefined;
	if (!backend?.resume) {
		throw new ImageBackendError('unconfigured', `${handle.backend} can't pick a job up again.`);
	}
	const result = await backend.resume(handle, { signal: opts.signal, onProgress: opts.onProgress });
	const image = result.images[0];
	if (!image) throw new ImageBackendError('rejected', 'The image backend returned no image.');
	return {
		bytes: image.bytes,
		width: image.width,
		height: image.height,
		seed: result.meta.seed,
		model: result.meta.model,
		notes: []
	};
}
