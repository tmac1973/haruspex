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
import { resolveImageBackend } from './backend';
import { ImageBackendError, type ImageProgress, type ImageRequest } from './types';
import { getSettings } from '$lib/stores/settings';
import { familyOf } from './comfyui/families';

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
}

/** What a failure from a full GPU looks like, from either engine. */
const GPU_FULL =
	/vae encode compute failed|cannot make enough memory available|out of memory|generate_image returned no results/i;

export const GPU_FULL_SENTENCE =
	'The image engine ran out of GPU memory beside the chat model. A smaller chat model in ' +
	'Settings → Models, or ComfyUI on another machine in Settings → Image, would leave room.';

/** The configured model can't be used commercially. */
export function nonCommercialModel(): boolean {
	const s = getSettings();
	if (s.imageBackendKind === 'local') return s.imageLocalModelId === 'qwen21';
	if (s.imageBackendKind === 'comfyui') return familyOf(s.imageComfyCheckpoint ?? '') === 'qwen21';
	return false;
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
	const caps = await backend.capabilities();
	const request: ImageRequest = { ...req };
	if (request.transparent && !caps.transparency) {
		request.transparent = false;
		notes.push('This backend cannot make transparent images, so the background is solid.');
	}
	if (request.seamless && !caps.seamlessTiling) {
		request.seamless = false;
		notes.push('This backend cannot make tiling textures, so the edges may not wrap.');
	}

	let result;
	try {
		result = await backend.generate(request, { signal: opts.signal, onProgress: opts.onProgress });
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		if (backend.kind === 'local' && GPU_FULL.test(detail)) {
			throw new ImageBackendError('unreachable', `${GPU_FULL_SENTENCE} (${detail})`);
		}
		throw e;
	}
	const image = result.images[0];
	if (!image) throw new ImageBackendError('rejected', 'The image backend returned no image.');
	if (result.meta.seamFailed) notes.push(`It does not tile: ${result.meta.seamFailed}`);
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
