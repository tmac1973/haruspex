/**
 * One image for a model's tool call: made by the saved image model that can
 * do it (`#lib/image/route.ts`), checked first and explained when it fails.
 *
 * `generateOneImage` is the Settings test button's primitive, and it says
 * nothing when things go wrong: that's fine for a button, but a model told only
 * "rejected" retries the same call or gives up silently. This wraps the
 * backend so a tool can hand the model a sentence it can pass on: what is not
 * set up, what no model can do, why the GPU said no.
 *
 * It takes a whole `ImageRequest`, so the Shell assistant's asset tool can
 * pass the asset job's requests through unchanged (phase 08).
 */
import { invoke } from '@tauri-apps/api/core';
import type { ImageJobHandle } from '#lib/image/backend.ts';
import type { ImageResultCheck } from '#lib/ipc/gen/ImageResultCheck.ts';
import { backendForEntry } from '#lib/image/registry.ts';
import { entryForHandle, imageEntries } from '#lib/image/entries.ts';
import { needOf, routeImage, upscaleNeed, type RouteOptions } from '#lib/image/route.ts';
import { errMessage } from '#lib/utils/error.ts';
import {
	ImageBackendError,
	type ImageBackendCapabilities,
	type ImageInput,
	type ImageModelEntry,
	type ImageProgress,
	type ImageRequest
} from '#lib/image/types.ts';
import { familyOf } from '#lib/image/comfyui/families.ts';
import { toolchestInstance } from '#lib/image/toolchest/backend.ts';

export { NO_EDIT_SENTENCE, NO_EXTEND_SENTENCE, NO_UPSCALE_SENTENCE } from '#lib/image/route.ts';

export interface ToolImage {
	bytes: Uint8Array;
	width: number;
	height: number;
	seed: number;
	model: string;
	/** Things the model should know: options dropped, licence limits, which model made it. */
	notes: string[];
}

export interface ForToolOptions extends RouteOptions {
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

/** `run`, with the bundled engine's full-GPU failure said in words. */
async function explained<T>(entry: ImageModelEntry, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		const detail = errMessage(e);
		if (entry.backend === 'local' && GPU_FULL.test(detail)) {
			throw new ImageBackendError('unreachable', `${GPU_FULL_SENTENCE} (${detail})`);
		}
		throw e;
	}
}

/**
 * A picture four times larger, from the first saved model that upscales, or a
 * sentence the model can pass on when none can. RGB: the caller restores alpha.
 */
export async function upscaleForTool(
	input: ImageInput,
	opts: ForToolOptions = {}
): Promise<Uint8Array> {
	const routed = await routeImage(
		upscaleNeed(),
		(entry, backend) =>
			explained(entry, () =>
				backend.upscale!(input, {
					signal: opts.signal,
					onProgress: opts.onProgress,
					onHandle: opts.onHandle
				})
			),
		opts
	);
	return routed.value;
}

/** `entry`'s model can't be used commercially. */
export function nonCommercialModel(entry: ImageModelEntry | null): boolean {
	if (!entry) return false;
	if (entry.backend === 'local' || entry.backend === 'lemonade') return entry.model === 'qwen21';
	// As the last probe or generation saw it; an unknown recipe isn't flagged.
	if (entry.backend === 'llama-toolchest') {
		return toolchestInstance(entry)?.commercialUse === false;
	}
	const family = familyOf(entry.model);
	return family === 'qwen21' || family === 'qwen21_turbo';
}

/**
 * `req` as the chosen model can take it: transparency or tiling it can't do
 * is dropped, saying so in `notes`. What it must do was checked by routing.
 */
function fitRequest(
	req: ImageRequest,
	caps: ImageBackendCapabilities,
	notes: string[]
): ImageRequest {
	const request: ImageRequest = { ...req };
	if (request.transparent && !caps.transparency) {
		request.transparent = false;
		notes.push('This model cannot make transparent images, so the background is solid.');
	}
	if (request.seamless && !caps.seamlessTiling) {
		request.seamless = false;
		notes.push('This model cannot make tiling textures, so the edges may not wrap.');
	}
	return request;
}

/** Said when a made picture is one flat colour. */
export const BLANK_NOTE =
	'It came out blank, one flat colour with nothing in it: the model failed even though the server said it was done. Try again with another seed, or another model.';

/** Said when a transparent request came back with no transparent pixel at all. */
export const NO_ALPHA_NOTE =
	'No part of it is transparent: the background is solid, and a checkerboard in it is painted, not real transparency. Say so to the user rather than using it as a cutout.';

/**
 * What the picture shows that the backend's "done" doesn't, as notes: a blank
 * frame, or a transparent request with no alpha. Backends don't all check
 * (only Lemonade's Ming did), and an edit reported as made came back black
 * and a cutout as an opaque RGB with a drawn checkerboard (#1032). A check
 * that can't run says nothing.
 */
async function resultNotes(
	bytes: Uint8Array,
	transparent: boolean,
	alreadySaid: boolean
): Promise<string[]> {
	let check: ImageResultCheck;
	try {
		check = await invoke<ImageResultCheck>('image_result_check', { bytes: Array.from(bytes) });
	} catch {
		return [];
	}
	return [
		...(check.blank ? [BLANK_NOTE] : []),
		...(transparent && !alreadySaid && check.transparent === 0 ? [NO_ALPHA_NOTE] : [])
	];
}

export async function generateForTool(
	req: ImageRequest,
	opts: ForToolOptions = {}
): Promise<ToolImage> {
	const notes: string[] = [];
	let transparent = false;
	const { entry, value: result } = await routeImage(
		needOf(req),
		(entry, backend, caps) => {
			notes.length = 0;
			const request = fitRequest(req, caps, notes);
			transparent = !!request.transparent;
			return explained(entry, () =>
				backend.generate(request, {
					signal: opts.signal,
					onProgress: opts.onProgress,
					onHandle: opts.onHandle
				})
			);
		},
		opts
	);
	const image = result.images[0];
	if (!image) throw new ImageBackendError('rejected', 'The image backend returned no image.');
	if (result.meta.seamFailed) notes.push(`It does not tile: ${result.meta.seamFailed}`);
	if (result.meta.transparencyFailed) notes.push(result.meta.transparencyFailed);
	notes.unshift(...(await resultNotes(image.bytes, transparent, !!result.meta.transparencyFailed)));
	if (nonCommercialModel(entry)) {
		notes.push('The model that drew it is licensed for non-commercial use only.');
	}
	if (imageEntries().length > 1 && entry.name !== result.meta.model) {
		notes.push(`Made with ${entry.name}.`);
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
