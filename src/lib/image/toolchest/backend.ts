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

import { sleep } from '#lib/utils/async.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { registerImageBackend } from '#lib/image/registry.ts';
import type { GenerateOptions, ImageBackend, ProbeResult } from '#lib/image/backend.ts';
import {
	ImageBackendError,
	type ImageBackendCapabilities,
	type ImageRequest,
	type ImageResult,
	type SamplerSettings
} from '#lib/image/types.ts';
import { FAMILY_SAMPLER } from '#lib/image/local/adapter.ts';
import { randomSeed } from '#lib/image/lemonade/adapter.ts';
import { transparentStart } from '#lib/image/sdcpp.ts';
import {
	familyOfRecipe,
	parseGenerationModels,
	toolchestKeyFor,
	type ToolchestInstance
} from '#lib/toolchest/models.ts';
import {
	ToolchestError,
	hostOf,
	toolchestBytes,
	toolchestJson,
	type ToolchestConfig
} from '#lib/toolchest/client.ts';
import {
	ROUTES,
	buildImageBody,
	imagesFrom,
	progressOf,
	readJob,
	type ImageJob
} from '#lib/image/toolchest/adapter.ts';

/** The blocking route waits through the queue and the render. */
const SYNC_TIMEOUT_MS = 900_000;
const POLL_MS = 1000;
/** Polls in a row that may fail before the server counts as gone. */
const MAX_FAILED_POLLS = 20;

/** What a probe or a generation last saw, for the sync questions asked after. */
let lastInstances: ToolchestInstance[] = [];

async function config(): Promise<ToolchestConfig> {
	const s = getSettings();
	return {
		baseUrl: s.imageToolchestBaseUrl.trim(),
		apiKey: await toolchestKeyFor(s.imageToolchestApiKeyId)
	};
}

function chosenId(): string {
	return (getSettings().imageToolchestModelId ?? '').trim();
}

function asImageError(e: unknown): unknown {
	if (!(e instanceof ToolchestError)) return e;
	if (e.kind === 'cancelled') return new ImageBackendError('cancelled', 'Generation cancelled.');
	return new ImageBackendError(e.kind, e.message, { status: e.status });
}

/** The server's image instances, remembered for {@link toolchestInstance}. */
export async function imageInstances(
	cfg: ToolchestConfig,
	signal?: AbortSignal
): Promise<ToolchestInstance[]> {
	lastInstances = parseGenerationModels(
		await toolchestJson(cfg, { path: ROUTES.models }, signal),
		'image'
	);
	return lastInstances;
}

/** Every instance the last probe or generation saw. */
export function seenInstances(): ToolchestInstance[] {
	return lastInstances;
}

/** The chosen instance as last seen, without asking the server. */
export function toolchestInstance(): ToolchestInstance | undefined {
	const id = chosenId();
	return lastInstances.find((i) => i.id === id);
}

/** Its catalogue family (`ming`, `qwen21`), when Haruspex knows the recipe. */
export function toolchestFamily(): 'ming' | 'qwen21' | null {
	return familyOfRecipe(toolchestInstance()?.recipe ?? '');
}

function canBeTransparent(i: ToolchestInstance | undefined): boolean {
	return !!i && (i.capabilities.includes('alpha') || familyOfRecipe(i.recipe) !== null);
}

/** A model's line in the dropdown. */
export function instanceLabel(i: ToolchestInstance): string {
	return i.state === 'running' ? i.id : `${i.id} — ${i.state}`;
}

const NO_TILING = 'llama-toolchest cannot make tiling textures, so the edges may not wrap.';

async function readyInstance(cfg: ToolchestConfig, signal?: AbortSignal) {
	if (!cfg.baseUrl) {
		throw new ImageBackendError(
			'unconfigured',
			'No llama-toolchest server is set — Settings → Image.'
		);
	}
	const id = chosenId();
	if (!id)
		throw new ImageBackendError('unconfigured', 'No image model is chosen — Settings → Image.');
	const instance = (await imageInstances(cfg, signal)).find((i) => i.id === id);
	if (!instance) {
		throw new ImageBackendError(
			'unconfigured',
			`${id} is not on ${hostOf(cfg.baseUrl)} any more — Settings → Image.`
		);
	}
	if (instance.state !== 'running') {
		throw new ImageBackendError(
			'unconfigured',
			`${id} is ${instance.state} — start it in llama-toolchest.`
		);
	}
	return instance;
}

/**
 * Poll a job until it ends, reporting its phase. A poll that fails is
 * retried, up to {@link MAX_FAILED_POLLS} in a row: a server being redeployed
 * comes back with the job gone, which ends it as a failure anyway.
 */
async function pollToEnd(
	cfg: ToolchestConfig,
	created: ImageJob,
	opts: GenerateOptions
): Promise<ImageJob> {
	let job = created;
	let failed = 0;
	while (job.status === 'queued' || job.status === 'running') {
		opts.onProgress?.(progressOf(job));
		await sleep(POLL_MS);
		if (opts.signal?.aborted) throw new ImageBackendError('cancelled', 'Generation cancelled.');
		try {
			job = readJob(await toolchestJson(cfg, { path: ROUTES.job(job.id) }, opts.signal)) ?? job;
			failed = 0;
		} catch (e) {
			if (e instanceof ToolchestError && e.kind === 'cancelled') throw e;
			if (++failed >= MAX_FAILED_POLLS) throw e;
		}
	}
	return job;
}

/** Run a job to its end and fetch its images. Cancelling the turn cancels the job. */
async function runJob(
	cfg: ToolchestConfig,
	body: unknown,
	opts: GenerateOptions
): Promise<Uint8Array[]> {
	const created = readJob(
		await toolchestJson(cfg, { method: 'POST', path: ROUTES.jobs, body }, opts.signal)
	);
	if (!created) throw new ImageBackendError('rejected', 'llama-toolchest made no job.');
	const cancel = () =>
		void toolchestJson(cfg, { method: 'DELETE', path: ROUTES.job(created.id) }).catch(() => {});
	opts.signal?.addEventListener('abort', cancel, { once: true });
	try {
		const job = await pollToEnd(cfg, created, opts);
		if (job.status === 'cancelled') {
			throw new ImageBackendError('cancelled', 'Generation cancelled.');
		}
		if (job.status === 'failed') {
			throw new ImageBackendError('rejected', `llama-toolchest: ${job.error ?? 'the job failed'}`);
		}
		opts.onProgress?.({ phase: 'downloading' });
		const images: Uint8Array[] = [];
		for (const path of job.images) images.push(await toolchestBytes(cfg, path, opts.signal));
		return images;
	} finally {
		opts.signal?.removeEventListener('abort', cancel);
	}
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
		let instance = toolchestInstance();
		if (!instance) {
			instance = await imageInstances(await config())
				.then((all) => all.find((i) => i.id === chosenId()))
				.catch(() => undefined);
		}
		return {
			transparency: canBeTransparent(instance),
			seamlessTiling: false,
			loras: false,
			maxLoras: 0
		};
	},

	async probe(): Promise<ProbeResult> {
		const cfg = await config();
		if (!cfg.baseUrl) return { ok: false, detail: 'No server address — Settings → Image.' };
		const host = hostOf(cfg.baseUrl);
		let instances: ToolchestInstance[];
		try {
			instances = await imageInstances(cfg);
		} catch (e) {
			if (e instanceof ToolchestError && e.status === 401) {
				return { ok: false, detail: 'Wrong or missing API key.' };
			}
			if (e instanceof ToolchestError && e.kind === 'unreachable') {
				return { ok: false, detail: `Can't reach ${host}.` };
			}
			return { ok: false, detail: e instanceof Error ? e.message : String(e) };
		}
		const models = instances.map((i) => ({ name: i.id, label: instanceLabel(i) }));
		if (instances.length === 0) {
			return {
				ok: false,
				detail: `${host} has no image models. Add one in llama-toolchest.`,
				models
			};
		}
		const chosen = instances.find((i) => i.id === chosenId());
		if (!chosen) return { ok: false, detail: 'No model is chosen — Settings → Image.', models };
		if (chosen.state !== 'running') {
			return {
				ok: false,
				detail: `${chosen.id} is ${chosen.state} — start it in llama-toolchest.`,
				models
			};
		}
		const how = chosen.api.includes('images.jobs') ? 'image jobs' : 'one request per image';
		return { ok: true, detail: `Connected — ${chosen.id} on ${host}, ${how}.`, models };
	},

	async generate(req: ImageRequest, opts: GenerateOptions = {}): Promise<ImageResult> {
		const cfg = await config();
		let instance: ToolchestInstance;
		try {
			instance = await readyInstance(cfg, opts.signal);
		} catch (e) {
			throw asImageError(e);
		}
		const family = familyOfRecipe(instance.recipe);
		// A known family gets the sampler it was measured with, as on the
		// bundled engine; any other keeps the one toolchest started it with.
		const sent: SamplerSettings | undefined =
			req.sampler ?? (family ? { ...FAMILY_SAMPLER[family] } : undefined);
		const seed = req.seed ?? randomSeed();
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

		const started = Date.now();
		let images: Uint8Array[];
		try {
			if (instance.api.includes('images.jobs')) {
				images = await runJob(cfg, body, opts);
			} else {
				opts.onProgress?.({ phase: 'running' });
				images = imagesFrom(
					await toolchestJson(
						cfg,
						{ method: 'POST', path: ROUTES.generate, body, timeoutMs: SYNC_TIMEOUT_MS },
						opts.signal
					)
				);
			}
		} catch (e) {
			throw asImageError(e);
		}
		if (images.length === 0) {
			throw new ImageBackendError('rejected', 'llama-toolchest returned no image.');
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
				model: instance.id,
				backend: 'llama-toolchest',
				sampler: sent ?? { name: 'instance default', steps: 0, cfg: 0 },
				loras: [],
				durationMs: Date.now() - started,
				...(req.seamless ? { seamFailed: NO_TILING } : {})
			}
		};
	}
};

registerImageBackend(toolchestBackend);
