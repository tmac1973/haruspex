/**
 * The ComfyUI backend.
 *
 * Works out the configured model's family, picks that family's workflow for
 * what the request asks for, substitutes the parameters through its field map,
 * queues it, follows progress, and returns the bytes.
 *
 * `capabilities()` is COMPUTED from the active templates rather than asserted.
 * A user workflow with no LoRA slots reports `loras: false`, and the caller
 * degrades and records it — where a hardcoded `true` would make it silently
 * drop them, which is the failure this whole layer is arranged to prevent.
 */

import { getSettings } from '#lib/stores/settings.ts';
import { errMessage } from '#lib/utils/error.ts';
import { sleep } from '#lib/utils/async.ts';
import {
	ImageBackendError,
	type ImageBackendCapabilities,
	type ImageRequest,
	type ImageResult,
	type LoraRef,
	type SamplerSettings
} from '../types';
import type { GenerateOptions, ImageBackend } from '../backend';
import { applyFieldMap, validateFieldMap, type ComfyGraph, type FieldMap } from './fieldMap';
import { selectTemplate, templatesFor, type WorkflowTemplate } from './templates';
import { familyOf, hasModel, listModels, resolveCompanions, type ModelFamily } from './families';
import * as api from './client';

/** What a custom workflow samples with when a request says nothing. */
export const DEFAULT_SAMPLER: SamplerSettings = { name: 'euler_ancestral', steps: 28, cfg: 7 };

/**
 * A seed for a request that left it to the backend.
 *
 * Resolved here rather than left to the template: a template's own default is
 * a constant, so every unpinned request ran at the same seed, a retry repeated
 * the attempt it was retrying, and `meta.seed` reported a value nobody chose.
 */
export function randomSeed(): number {
	return Math.floor(Math.random() * 2_147_483_647);
}

function config(): api.ClientConfig {
	const s = getSettings();
	return { baseUrl: s.imageBackendBaseUrl, apiKey: s.imageBackendApiKey };
}

/**
 * A user-supplied workflow replaces all four bundled ones. Returns null when
 * neither path is set; throws when exactly one is, because half-configured is
 * a mistake rather than a mode.
 */
async function customTemplate(family: ModelFamily): Promise<WorkflowTemplate | null> {
	const s = getSettings();
	const graphPath = s.imageComfyWorkflowPath.trim();
	const mapPath = s.imageComfyFieldMapPath.trim();
	if (!graphPath && !mapPath) return null;
	if (!graphPath || !mapPath) {
		throw new ImageBackendError(
			'unconfigured',
			graphPath
				? 'A custom workflow is set but its field map is not — Settings → Image.'
				: 'A custom field map is set but its workflow is not — Settings → Image.'
		);
	}
	const { invoke } = await import('@tauri-apps/api/core');
	const read = async (p: string) => (await invoke('fs_read_text_absolute', { path: p })) as string;
	let graph: ComfyGraph;
	let map: FieldMap;
	try {
		graph = JSON.parse(await read(graphPath)) as ComfyGraph;
		map = JSON.parse(await read(mapPath)) as FieldMap;
	} catch (e) {
		throw new ImageBackendError(
			'unconfigured',
			`Could not read the custom workflow — ${errMessage(e)}`
		);
	}
	return {
		id: 'custom',
		family,
		graph,
		map,
		license: 'Supplied by the user.',
		source: graphPath,
		supports: {
			// A custom graph cannot be asked how it would make alpha, so it is
			// never claimed; it is trusted about its own tiling.
			transparent: false,
			seamless: true
		},
		defaultSampler: DEFAULT_SAMPLER
	};
}

function configuredModel(): string {
	return getSettings().imageComfyCheckpoint.trim();
}

async function activeTemplates(family: ModelFamily): Promise<WorkflowTemplate[]> {
	const custom = await customTemplate(family);
	return custom ? [custom] : templatesFor(family);
}

function capabilitiesOf(templates: WorkflowTemplate[]): ImageBackendCapabilities {
	const loraNodes = Math.max(
		0,
		...templates.map((t) => (t.map.loras ? t.map.loras.nodes.length : 0))
	);
	return {
		transparency: templates.some((t) => t.supports.transparent),
		seamlessTiling: templates.some((t) => t.supports.seamless),
		loras: loraNodes > 0,
		maxLoras: loraNodes
	};
}

/** The template for this request. Falls back as `selectTemplate` describes. */
function templateFor(req: ImageRequest, templates: WorkflowTemplate[]): WorkflowTemplate {
	const want = { transparent: Boolean(req.transparent), seamless: Boolean(req.seamless) };
	const picked = selectTemplate(want, templates) ?? templates[0];
	if (!picked) {
		throw new ImageBackendError('unconfigured', 'No bundled workflow serves this model.');
	}
	return picked;
}

async function probeModel(
	cfg: api.ClientConfig,
	family: ModelFamily,
	name: string
): Promise<string | null> {
	if (!name) {
		return 'No model is set — Settings → Image.';
	}
	// A server that will not answer object_info still answers system_stats;
	// this check is a convenience, not a gate.
	if ((await hasModel(cfg, family, name)) === false) {
		return family === 'sd'
			? `The backend does not have a checkpoint called "${name}" — pick one it has in Settings → Image.`
			: `The backend does not have a diffusion model called "${name}" in models/diffusion_models — Settings → Image → Install.`;
	}
	if (family !== 'sd') {
		try {
			await resolveCompanions(cfg, family);
		} catch (e) {
			return errMessage(e);
		}
	}
	return null;
}

/**
 * The graph for one request, with everything the request left open resolved:
 * the model and its family, the family's workflow and companion files, the
 * sampler the workflow runs, and a real seed.
 */
async function prepare(cfg: api.ClientConfig, req: ImageRequest) {
	const model = (req.model ?? configuredModel()).trim();
	const family = familyOf(model);
	const template = templateFor(req, await activeTemplates(family));
	const companions =
		family !== 'sd' && (template.map.textEncoder || template.map.vae)
			? await resolveCompanions(cfg, family)
			: undefined;

	const sampler = req.sampler ?? template.defaultSampler;
	const loras: LoraRef[] = (req.loras ?? []).slice(0, template.map.loras?.nodes.length ?? 0);
	const seed = req.seed ?? randomSeed();
	const prompt =
		req.transparent && template.supports.transparent && template.wrapPrompt
			? template.wrapPrompt(req.prompt)
			: req.prompt;

	const graph = applyFieldMap(
		template.graph,
		template.map,
		{ ...req, prompt, seed, sampler, loras },
		{ model, ...companions }
	);
	return { template, graph, model, sampler, loras, seed };
}

/**
 * `p`, unless `signal` aborts first: then `onAbort` runs and this rejects as
 * cancelled at once, while `p` carries on.
 */
function untilAborted<T>(
	p: Promise<T>,
	signal: AbortSignal | undefined,
	onAbort: () => void
): Promise<T> {
	if (!signal) return p;
	const cancelled = () => new ImageBackendError('cancelled', 'Generation cancelled.');
	if (signal.aborted) {
		onAbort();
		return Promise.reject(cancelled());
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			onAbort();
			reject(cancelled());
		};
		signal.addEventListener('abort', abort, { once: true });
		p.then(
			(v) => {
				signal.removeEventListener('abort', abort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener('abort', abort);
				reject(e);
			}
		);
	});
}

export const comfyUiBackend: ImageBackend = {
	kind: 'comfyui',

	async capabilities() {
		return capabilitiesOf(await activeTemplates(familyOf(configuredModel())));
	},

	async probe() {
		const cfg = config();
		if (!cfg.baseUrl.trim()) {
			return { ok: false, detail: 'No backend URL is set — Settings → Image.' };
		}
		const model = configuredModel();
		const family = familyOf(model);
		let templates: WorkflowTemplate[];
		try {
			templates = await activeTemplates(family);
		} catch (e) {
			return { ok: false, detail: errMessage(e) };
		}
		// Validate before reaching the network: a template out of sync with its
		// map must fail here, not forty images into an overnight run.
		for (const t of templates) {
			const problems = validateFieldMap(t.graph, t.map);
			if (problems.length > 0) {
				return { ok: false, detail: `Workflow "${t.id}": ${problems[0]}` };
			}
		}
		try {
			const stats = await api.systemStats(cfg);
			const devices = stats.devices as Array<{ name?: string }> | undefined;
			const device = devices?.[0]?.name ?? 'unknown device';
			// Listed before the model is checked: "no model is set" is exactly
			// when the user needs to see what there is to choose from.
			const models = (await listModels(cfg)).map(({ name, label }) => ({ name, label }));
			const bad = await probeModel(cfg, family, model);
			if (bad) return { ok: false, detail: bad, models };
			return { ok: true, detail: `Connected — ${device}.`, models };
		} catch (e) {
			return { ok: false, detail: errMessage(e) };
		}
	},

	async generate(req: ImageRequest, opts: GenerateOptions = {}): Promise<ImageResult> {
		const cfg = config();
		const started = Date.now();
		const { template, graph, model, sampler, loras, seed } = await prepare(cfg, req);
		const clientId = crypto.randomUUID();
		// Unique per request so concurrent submissions cannot be confused for
		// one another in /history.
		const save = graph[template.map.outputNode];
		if (save) save.inputs.filename_prefix = `haruspex/${clientId}`;

		let socketAlive = true;
		const closeSocket = api.subscribe(
			cfg,
			clientId,
			(p) => opts.onProgress?.(p),
			() => {
				socketAlive = false;
			},
			(id) => graph[id]?.class_type
		);

		let promptId: string | null = null;
		try {
			// Not given the abort signal: a submit cut short can leave the prompt
			// queued with its id lost, and it would then run anyway. A cancel
			// during submit settles at once; the prompt is removed once submit
			// says what it was.
			const submitting = api.submit(cfg, graph, clientId);
			promptId = await untilAborted(submitting, opts.signal, () => {
				submitting.then(
					(id) => api.cancelPrompt(cfg, id),
					() => {}
				);
			});
			const deadline = started + api.GENERATION_TIMEOUT_MS;
			let images: api.HistoryImage[] | null = null;
			while (images === null) {
				if (opts.signal?.aborted) throw new ImageBackendError('cancelled', 'Generation cancelled.');
				if (Date.now() > deadline) {
					throw new ImageBackendError(
						'timeout',
						`The image backend did not finish within ${api.GENERATION_TIMEOUT_MS / 1000}s.`
					);
				}
				await sleep(api.HISTORY_POLL_MS);
				if (!socketAlive) opts.onProgress?.({ phase: 'running' });
				images = await api.history(cfg, promptId, template.map.outputNode, opts.signal);
			}

			opts.onProgress?.({ phase: 'downloading' });
			const bytes = await Promise.all(images.map((i) => api.view(cfg, i, opts.signal)));
			return {
				images: bytes.map((b) => ({
					bytes: b,
					mimeType: 'image/png',
					width: req.width,
					height: req.height
				})),
				meta: {
					seed,
					model,
					backend: 'comfyui',
					sampler,
					loras,
					durationMs: Date.now() - started
				}
			};
		} catch (e) {
			if (opts.signal?.aborted) {
				// In the background: the generation settles as cancelled now.
				if (promptId) void api.cancelPrompt(cfg, promptId);
				throw new ImageBackendError('cancelled', 'Generation cancelled.');
			}
			throw e;
		} finally {
			closeSocket();
		}
	}
};
