/**
 * A llama-toolchest server's image instances as the image backend.
 *
 * Toolchest runs the sd-server processes and their queue; Haruspex picks an
 * instance by id (`imageToolchestModelId`) and sends it the request. Starting
 * an instance or installing a model set stays in toolchest's own UI, so a
 * stopped instance is a sentence pointing there, not a button here.
 *
 * Where the build has image jobs (`meta.api` lists `images.jobs`) a request is
 * a job: polled once a second for its phase and its place in the queue, and
 * cancelled with `DELETE` when the turn is. Otherwise it is the blocking
 * OpenAI route, cancelled by dropping the request, which toolchest honours
 * only while the request still waits in its queue.
 */

import { registerImageBackend } from '#lib/image/registry.ts';
import type {
	GenerateOptions,
	ImageBackend,
	ImageJobHandle,
	ProbeResult
} from '#lib/image/backend.ts';
import {
	ImageBackendError,
	type ImageBackendCapabilities,
	type ImageRequest,
	type ImageResult,
	type SamplerSettings
} from '#lib/image/types.ts';
import { FAMILY_SAMPLER } from '#lib/image/local/adapter.ts';
import { randomSeed } from '#lib/utils/random.ts';
import { transparentStart } from '#lib/image/sdcpp.ts';
import { editUploads, imagesFrom } from '#lib/image/openaiImages.ts';
import { familyOfRecipe, type ToolchestInstance } from '#lib/toolchest/models.ts';
import {
	ToolchestError,
	toolchestBytes,
	toolchestJson,
	toolchestUpload,
	type ToolchestConfig
} from '#lib/toolchest/client.ts';
import { settleJob, toolchestKind } from '#lib/toolchest/kind.ts';
import {
	ROUTES,
	buildEditFields,
	buildImageBody,
	progressOf,
	readJob,
	type ImageJob
} from '#lib/image/toolchest/adapter.ts';
import { followJob, removeJob } from '#lib/toolchest/jobs.ts';

/** The blocking route waits through the queue and the render. */
const SYNC_TIMEOUT_MS = 900_000;

const server = toolchestKind('image');

function asImageError(e: unknown): unknown {
	if (!(e instanceof ToolchestError)) return e;
	if (e.kind === 'cancelled') return new ImageBackendError('cancelled', 'Generation cancelled.');
	return new ImageBackendError(e.kind, e.message, { status: e.status });
}

/** Every instance the last probe or generation saw. */
export const seenInstances = server.seen;

/** The chosen instance as last seen, without asking the server. */
export const toolchestInstance = server.chosen;

/** Its catalogue family (`ming`, `qwen21`), when Haruspex knows the recipe. */
export function toolchestFamily(): 'ming' | 'qwen21' | null {
	return familyOfRecipe(toolchestInstance()?.recipe ?? '');
}

/** sd-server's reference pictures for FLUX.2 klein, the set that edits. */
const MAX_EDIT_IMAGES = 4;

/** The set edits, and this build serves `/v1/images/edits` for it. */
function canEdit(i: ToolchestInstance | undefined): boolean {
	return !!i && i.capabilities.includes('edit') && i.api.includes('images.edits');
}

function canBeTransparent(i: ToolchestInstance | undefined): boolean {
	return !!i && (i.capabilities.includes('alpha') || familyOfRecipe(i.recipe) !== null);
}

const NO_TILING = 'llama-toolchest cannot make tiling textures, so the edges may not wrap.';

/**
 * Run a job to its end and fetch its images. Cancelling the turn cancels the
 * job. `onJob` hears its id as soon as the server has it.
 */
async function runJob(
	cfg: ToolchestConfig,
	body: unknown,
	opts: GenerateOptions,
	onJob: (id: string) => void
): Promise<Uint8Array[]> {
	const created = readJob(
		await toolchestJson(cfg, { method: 'POST', path: ROUTES.jobs, body }, opts.signal)
	);
	if (!created) throw new ImageBackendError('rejected', 'llama-toolchest made no job.');
	onJob(created.id);
	return awaitJob(cfg, created, opts);
}

/** Follow a job the server has to its end, fetch its images, and delete it there. */
async function awaitJob(
	cfg: ToolchestConfig,
	created: ImageJob,
	opts: GenerateOptions
): Promise<Uint8Array[]> {
	const job = settleJob(
		await followJob(cfg, created, ROUTES.job, readJob, {
			signal: opts.signal,
			onJob: (j) => opts.onProgress?.(progressOf(j))
		})
	);
	opts.onProgress?.({ phase: 'downloading' });
	const images: Uint8Array[] = [];
	for (const path of job.images) images.push(await toolchestBytes(cfg, path, opts.signal));
	removeJob(cfg, ROUTES.job(job.id));
	return images;
}

/**
 * The prompt and start image for `instance`. Ming needs a clear canvas as well
 * as its phrase, Qwen only the phrase; an instance of neither family that
 * says `alpha` is taken at its word and started as Ming is. Any other draws
 * opaque.
 */
async function startFor(
	instance: ToolchestInstance,
	req: ImageRequest
): Promise<{ prompt: string; clearStart?: string }> {
	const family = familyOfRecipe(instance.recipe);
	if (family) return transparentStart(family, req);
	if (instance.capabilities.includes('alpha')) return transparentStart('ming', req);
	return { prompt: req.prompt };
}

export const toolchestBackend: ImageBackend = {
	kind: 'llama-toolchest',

	async capabilities(): Promise<ImageBackendCapabilities> {
		let instance = server.chosen();
		if (!instance) {
			instance = await server
				.instances(await server.config())
				.then((all) => all.find((i) => i.id === server.chosenId()))
				.catch(() => undefined);
		}
		return {
			transparency: canBeTransparent(instance),
			seamlessTiling: false,
			loras: false,
			maxLoras: 0,
			edit: canEdit(instance),
			maxEditImages: canEdit(instance) ? MAX_EDIT_IMAGES : 0
		};
	},

	probe(): Promise<ProbeResult> {
		return server.probe((chosen) =>
			chosen.api.includes('images.jobs') ? 'image jobs' : 'one request per image'
		);
	},

	async generate(req: ImageRequest, opts: GenerateOptions = {}): Promise<ImageResult> {
		const cfg = await server.config();
		let instance: ToolchestInstance;
		try {
			instance = await server.readyInstance(cfg, opts.signal);
		} catch (e) {
			throw asImageError(e);
		}
		const family = familyOfRecipe(instance.recipe);
		// A known family gets the sampler it was measured with, as on the
		// bundled engine; any other keeps the one toolchest started it with.
		const sent: SamplerSettings | undefined =
			req.sampler ?? (family ? { ...FAMILY_SAMPLER[family] } : undefined);
		const seed = req.seed ?? randomSeed();
		if (req.edit) {
			if (!canEdit(instance)) {
				throw new ImageBackendError(
					'unconfigured',
					`${instance.id} can't edit pictures — choose a model that can in Settings → Image.`
				);
			}
			const fields = buildEditFields({
				model: instance.id,
				prompt: req.prompt,
				negativePrompt: req.negativePrompt,
				seed,
				width: req.width,
				height: req.height,
				sampler: sent
			});
			return finish(req, instance, seed, sent, Date.now(), () => {
				opts.onProgress?.({ phase: 'running' });
				return toolchestUpload(
					cfg,
					{ path: ROUTES.edits, body: fields, timeoutMs: SYNC_TIMEOUT_MS },
					editUploads(req.edit!),
					opts.signal,
					true
				).then(imagesFrom);
			});
		}
		const start = await startFor(instance, req);
		const body = buildImageBody({
			model: instance.id,
			prompt: start.prompt,
			negativePrompt: req.negativePrompt,
			seed,
			width: req.width,
			height: req.height,
			sampler: sent,
			clearStart: start.clearStart
		});

		return finish(req, instance, seed, sent, Date.now(), async () => {
			if (instance.api.includes('images.jobs')) {
				return runJob(cfg, body, opts, (id) =>
					opts.onHandle?.({
						backend: 'llama-toolchest',
						baseUrl: cfg.baseUrl,
						id,
						seed,
						model: instance.id,
						width: req.width,
						height: req.height,
						extra: { keyId: server.keyId() }
					})
				);
			}
			opts.onProgress?.({ phase: 'running' });
			return imagesFrom(
				await toolchestJson(
					cfg,
					{ method: 'POST', path: ROUTES.generate, body, timeoutMs: SYNC_TIMEOUT_MS },
					opts.signal
				)
			);
		});
	},

	async resume(handle: ImageJobHandle, opts: GenerateOptions = {}): Promise<ImageResult> {
		// The server it went to, whatever Settings → Image says now.
		const cfg = await server.configFor(handle.baseUrl, handle.extra?.keyId);
		const started = Date.now();
		let images: Uint8Array[];
		try {
			images = await awaitJob(
				cfg,
				{ id: handle.id, status: 'queued', phase: '', ahead: 0, images: [], error: null },
				opts
			);
		} catch (e) {
			throw asImageError(e);
		}
		return toImageResult(images, {
			width: handle.width,
			height: handle.height,
			seed: handle.seed,
			model: handle.model,
			sampler: { name: 'as sent', steps: 0, cfg: 0 },
			started
		});
	}
};

/** Run `draw` and shape what it made into a result. */
async function finish(
	req: ImageRequest,
	instance: ToolchestInstance,
	seed: number,
	sent: SamplerSettings | undefined,
	started: number,
	draw: () => Promise<Uint8Array[]>
): Promise<ImageResult> {
	let images: Uint8Array[];
	try {
		images = await draw();
	} catch (e) {
		throw asImageError(e);
	}
	return toImageResult(images, {
		width: req.width,
		height: req.height,
		seed,
		model: instance.id,
		sampler: sent ?? { name: 'instance default', steps: 0, cfg: 0 },
		started,
		seamFailed: req.seamless ? NO_TILING : undefined
	});
}

/** What a generation or a resumed job made, as a result; refused when it made nothing. */
function toImageResult(
	images: Uint8Array[],
	made: {
		width: number;
		height: number;
		seed: number;
		model: string;
		sampler: SamplerSettings;
		started: number;
		seamFailed?: string;
	}
): ImageResult {
	if (images.length === 0) {
		throw new ImageBackendError('rejected', 'llama-toolchest returned no image.');
	}
	return {
		images: images.map((bytes) => ({
			bytes,
			mimeType: 'image/png',
			width: made.width,
			height: made.height
		})),
		meta: {
			seed: made.seed,
			model: made.model,
			backend: 'llama-toolchest',
			sampler: made.sampler,
			loras: [],
			durationMs: Date.now() - made.started,
			...(made.seamFailed ? { seamFailed: made.seamFailed } : {})
		}
	};
}

registerImageBackend(toolchestBackend);
