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
import {
	ImageBackendError,
	type ImageBackendCapabilities,
	type ImageInput,
	type ImageRequest,
	type ImageResult,
	type LoraRef,
	type SamplerSettings
} from '#lib/image/types.ts';
import type { GenerateOptions, ImageBackend, ImageJobHandle } from '#lib/image/backend.ts';
import {
	applyFieldMap,
	validateFieldMap,
	type ComfyGraph,
	type FieldMap
} from '#lib/image/comfyui/fieldMap.ts';
import {
	selectTemplate,
	templatesFor,
	type WorkflowTemplate
} from '#lib/image/comfyui/templates/index.ts';
import {
	familyOf,
	findUpscaler,
	hasModel,
	listModels,
	resolveCompanions,
	type ModelFamily
} from '#lib/image/comfyui/families.ts';
import * as api from '#lib/image/comfyui/client.ts';
import { uploadImage } from '#lib/image/comfyui/upload.ts';
import { resumePrompt, run } from '#lib/image/comfyui/run.ts';

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

/**
 * Pictures one edit combines, by family: Qwen-Image-2.1's encoder takes up to
 * 16, and three is where it still keeps them apart; klein is made for four.
 */
const MAX_EDIT_IMAGES: Partial<Record<ModelFamily, number>> = {
	qwen21: 3,
	qwen21_turbo: 3,
	flux2_klein: 4,
	qwen_edit_2511: 3
};

function capabilitiesOf(
	templates: WorkflowTemplate[],
	family: ModelFamily,
	serverEdits: boolean,
	upscaler: boolean
): ImageBackendCapabilities {
	const loraNodes = Math.max(
		0,
		...templates.map((t) => (t.map.loras ? t.map.loras.nodes.length : 0))
	);
	const edit = serverEdits && templates.some((t) => t.supports.edit);
	return {
		transparency: templates.some((t) => t.supports.transparent),
		seamlessTiling: templates.some((t) => t.supports.seamless),
		loras: loraNodes > 0,
		maxLoras: loraNodes,
		edit,
		maxEditImages: edit ? (MAX_EDIT_IMAGES[family] ?? 1) : 0,
		upscale: upscaler
	};
}

/**
 * The server's upscaler, or null. Asked every time rather than kept, so an
 * install from Settings → Image counts at once; a server that won't answer
 * has none.
 */
async function upscalerOf(cfg: api.ClientConfig): Promise<string | null> {
	return findUpscaler(cfg).catch(() => null);
}

/**
 * `upscale_image`'s graph: the picture through `UpscaleModelLoader` and
 * `ImageUpscaleWithModel`, which tiles it, so any size the tool accepts fits.
 */
export function upscaleGraph(image: string, model: string, prefix: string): ComfyGraph {
	return {
		'1': { class_type: 'LoadImage', inputs: { image } },
		'2': { class_type: 'UpscaleModelLoader', inputs: { model_name: model } },
		'3': {
			class_type: 'ImageUpscaleWithModel',
			inputs: { upscale_model: ['2', 0], image: ['1', 0] }
		},
		'4': { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: prefix } }
	};
}
const UPSCALE_OUTPUT = '4';

/** Per server and family: can it run the family's edit workflow? */
const editsByServer = new Map<string, Promise<boolean>>();

/** A node's inputs, required and optional; null when the server hasn't the node. */
async function nodeInputs(cfg: api.ClientConfig, cls: string): Promise<object | null> {
	const info = (await api.objectInfo(cfg, cls)) as Record<
		string,
		{ input?: Record<string, object> }
	> | null;
	const node = info?.[cls];
	return node ? { ...node.input?.required, ...node.input?.optional } : null;
}

/**
 * Whether the server can edit with `family`. Qwen-Image-2.1: ComfyUI added its
 * encoder's `images` input (and `vae`) after the node itself, so an older build
 * draws with it but cannot edit. klein: `ReferenceLatent`. 2511: its encoder.
 * Asked once per server and family; a failure isn't remembered.
 */
function serverEdits(cfg: api.ClientConfig, family: ModelFamily): Promise<boolean> {
	const key = `${cfg.baseUrl.trim()} ${family}`;
	let known = editsByServer.get(key);
	if (!known) {
		known = (
			family === 'flux2_klein'
				? nodeInputs(cfg, 'ReferenceLatent').then((all) => all !== null)
				: family === 'qwen_edit_2511'
					? nodeInputs(cfg, 'TextEncodeQwenImageEditPlus').then((all) => all !== null)
					: nodeInputs(cfg, 'TextEncodeQwenImage21').then(
							(all) => !!all && 'images' in all && 'vae' in all
						)
		).catch(() => {
			editsByServer.delete(key);
			return false;
		});
		editsByServer.set(key, known);
	}
	return known;
}

/** A PNG's size from its header, or null for anything else. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** The template for this request. Falls back as `selectTemplate` describes. */
function templateFor(req: ImageRequest, templates: WorkflowTemplate[]): WorkflowTemplate {
	const want = {
		transparent: Boolean(req.transparent),
		seamless: Boolean(req.seamless),
		edit: Boolean(req.edit)
	};
	const picked = selectTemplate(want, templates) ?? (req.edit ? undefined : templates[0]);
	if (!picked) {
		throw new ImageBackendError(
			'unconfigured',
			req.edit
				? "This model can't edit pictures here — choose Qwen-Image-2.1, FLUX.2 klein 4B or Qwen-Image-Edit-2511 in Settings → Image."
				: 'No bundled workflow serves this model.'
		);
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
async function prepare(cfg: api.ClientConfig, req: ImageRequest, signal?: AbortSignal) {
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
	// Each under a name of its own, so two edits at once can't swap pictures.
	const editImages = req.edit
		? await Promise.all(
				req.edit.images.map((input) =>
					uploadImage(cfg, input, `haruspex-edit-${crypto.randomUUID()}.png`, signal)
				)
			)
		: undefined;

	const graph = applyFieldMap(
		template.graph,
		template.map,
		{ ...req, prompt, seed, sampler, loras },
		{ model, ...companions, editImages }
	);
	return { template, graph, model, sampler, loras, seed };
}

export const comfyUiBackend: ImageBackend = {
	kind: 'comfyui',

	async capabilities() {
		const family = familyOf(configuredModel());
		const templates = await activeTemplates(family);
		const cfg = config();
		const [edits, upscaler] = await Promise.all([
			templates.some((t) => t.supports.edit) ? serverEdits(cfg, family) : false,
			upscalerOf(cfg)
		]);
		return capabilitiesOf(templates, family, edits, upscaler !== null);
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
		const { template, graph, model, sampler, loras, seed } = await prepare(cfg, req, opts.signal);
		const clientId = crypto.randomUUID();
		// Unique per request so concurrent submissions cannot be confused for
		// one another in /history.
		const save = graph[template.map.outputNode];
		if (save) save.inputs.filename_prefix = `haruspex/${clientId}`;
		const outputNode = template.map.outputNode;
		const bytes = await run(cfg, graph, outputNode, clientId, opts, (id) => ({
			backend: 'comfyui',
			baseUrl: cfg.baseUrl,
			id,
			seed,
			model,
			width: req.width,
			height: req.height,
			extra: { clientId, outputNode }
		}));
		return {
			// An edit is sized from its first picture, so read what came back.
			images: bytes.map((b) => ({
				bytes: b,
				mimeType: 'image/png',
				...(pngSize(b) ?? { width: req.width, height: req.height })
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
	},

	async upscale(input: ImageInput, opts: GenerateOptions = {}): Promise<Uint8Array> {
		const cfg = config();
		const model = await upscalerOf(cfg);
		if (!model) {
			throw new ImageBackendError(
				'unconfigured',
				'ComfyUI has no Real-ESRGAN x4plus in models/upscale_models — Settings → Image → Install.'
			);
		}
		const clientId = crypto.randomUUID();
		const image = await uploadImage(cfg, input, `haruspex-upscale-${clientId}.png`, opts.signal);
		const graph = upscaleGraph(image, model, `haruspex/${clientId}`);
		const [bytes] = await run(cfg, graph, UPSCALE_OUTPUT, clientId, opts, (id) => ({
			backend: 'comfyui',
			baseUrl: cfg.baseUrl,
			id,
			seed: 0,
			model,
			width: 0,
			height: 0,
			extra: { clientId, outputNode: UPSCALE_OUTPUT }
		}));
		if (!bytes) throw new ImageBackendError('rejected', 'ComfyUI returned no upscaled picture.');
		return bytes;
	},

	async resume(handle: ImageJobHandle, opts: GenerateOptions = {}): Promise<ImageResult> {
		const started = Date.now();
		const bytes = await resumePrompt(config(), handle, opts);
		return {
			images: bytes.map((b) => ({
				bytes: b,
				mimeType: 'image/png',
				...(pngSize(b) ?? { width: handle.width, height: handle.height })
			})),
			meta: {
				seed: handle.seed,
				model: handle.model,
				backend: 'comfyui',
				sampler: { name: 'as sent', steps: 0, cfg: 0 },
				loras: [],
				durationMs: Date.now() - started
			}
		};
	}
};
