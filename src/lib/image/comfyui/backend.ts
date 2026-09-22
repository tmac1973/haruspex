/**
 * The ComfyUI backend.
 *
 * Picks a workflow for what the request asks for, substitutes the parameters
 * through its field map, queues it, follows progress, and returns the bytes.
 *
 * `capabilities()` is COMPUTED from the active templates rather than asserted.
 * A user workflow with no LoRA slots reports `loras: false`, and the caller
 * degrades and records it — where a hardcoded `true` would make it silently
 * drop them, which is the failure this whole layer is arranged to prevent.
 */

import { getSettings } from '$lib/stores/settings';
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
import { selectTemplate, TEMPLATES, type WorkflowTemplate } from './templates';
import * as api from './client';

/** What the bundled graphs sample with when a request says nothing. */
export const DEFAULT_SAMPLER: SamplerSettings = { name: 'euler_ancestral', steps: 28, cfg: 7 };

function config(): api.ClientConfig {
	const s = getSettings();
	return { baseUrl: s.imageBackendBaseUrl, apiKey: s.imageBackendApiKey };
}

/**
 * A user-supplied workflow replaces all four bundled ones. Returns null when
 * neither path is set; throws when exactly one is, because half-configured is
 * a mistake rather than a mode.
 */
async function customTemplate(): Promise<WorkflowTemplate | null> {
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
			`Could not read the custom workflow — ${e instanceof Error ? e.message : String(e)}`
		);
	}
	return {
		id: 'custom',
		graph,
		map,
		license: 'Supplied by the user.',
		source: graphPath,
		supports: {
			reference: Boolean(map.referenceImage),
			seamless: true // A custom graph is trusted about its own tiling.
		}
	};
}

async function activeTemplates(): Promise<WorkflowTemplate[]> {
	const custom = await customTemplate();
	return custom ? [custom] : TEMPLATES;
}

function capabilitiesOf(templates: WorkflowTemplate[]): ImageBackendCapabilities {
	const loraNodes = Math.max(
		0,
		...templates.map((t) => (t.map.loras ? t.map.loras.nodes.length : 0))
	);
	return {
		referenceConditioning: templates.some((t) => t.supports.reference),
		seamlessTiling: templates.some((t) => t.supports.seamless),
		loras: loraNodes > 0,
		maxLoras: loraNodes
	};
}

/** The template for this request, with a message naming what is missing. */
function templateFor(req: ImageRequest, templates: WorkflowTemplate[]): WorkflowTemplate {
	const want = { reference: Boolean(req.referenceImage), seamless: Boolean(req.seamless) };
	const exact = selectTemplate(want, templates);
	if (exact) return exact;
	// A custom workflow is the only single-template case; it serves everything
	// it can and the caller degrades against `capabilities()`.
	if (templates.length === 1) return templates[0];
	throw new ImageBackendError(
		'unconfigured',
		`No bundled workflow generates ${want.seamless ? 'seamless ' : ''}images${
			want.reference ? ' conditioned on a reference' : ''
		}.`
	);
}

async function probeCheckpoint(cfg: api.ClientConfig, name: string): Promise<string | null> {
	if (!name.trim()) {
		return 'No checkpoint is set — Settings → Image.';
	}
	try {
		const info = (await api.objectInfo(cfg, 'CheckpointLoaderSimple')) as Record<
			string,
			{ input?: { required?: { ckpt_name?: [string[]] } } }
		>;
		const names = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
		if (Array.isArray(names) && names.length > 0 && !names.includes(name)) {
			return `The backend does not have a checkpoint called "${name}".`;
		}
	} catch {
		// A server that will not answer object_info still answers system_stats;
		// this check is a convenience, not a gate.
	}
	return null;
}

export const comfyUiBackend: ImageBackend = {
	kind: 'comfyui',

	async capabilities() {
		return capabilitiesOf(await activeTemplates());
	},

	async probe() {
		const cfg = config();
		if (!cfg.baseUrl.trim()) {
			return { ok: false, detail: 'No backend URL is set — Settings → Image.' };
		}
		let templates: WorkflowTemplate[];
		try {
			templates = await activeTemplates();
		} catch (e) {
			return { ok: false, detail: e instanceof Error ? e.message : String(e) };
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
			const bad = await probeCheckpoint(cfg, getSettings().imageComfyCheckpoint);
			if (bad) return { ok: false, detail: bad };
			return { ok: true, detail: `Connected — ${device}.` };
		} catch (e) {
			return { ok: false, detail: e instanceof Error ? e.message : String(e) };
		}
	},

	async generate(req: ImageRequest, opts: GenerateOptions = {}): Promise<ImageResult> {
		const cfg = config();
		const started = Date.now();
		const templates = await activeTemplates();
		const template = templateFor(req, templates);

		const model = (req.model ?? getSettings().imageComfyCheckpoint).trim();
		const sampler = req.sampler ?? DEFAULT_SAMPLER;
		const loras: LoraRef[] = (req.loras ?? []).slice(0, template.map.loras?.nodes.length ?? 0);
		const clientId = crypto.randomUUID();

		let referenceFilename: string | undefined;
		if (req.referenceImage && template.map.referenceImage) {
			referenceFilename = await api.uploadImage(
				cfg,
				req.referenceImage,
				`haruspex-ref-${clientId}.png`,
				opts.signal
			);
		}

		const graph = applyFieldMap(
			template.graph,
			template.map,
			{ ...req, sampler, loras },
			{ referenceFilename, model }
		);
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
			}
		);

		try {
			const promptId = await api.submit(cfg, graph, clientId, opts.signal);
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
				await new Promise((r) => setTimeout(r, api.HISTORY_POLL_MS));
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
					seed: req.seed ?? 0,
					model,
					backend: 'comfyui',
					sampler,
					loras,
					durationMs: Date.now() - started
				}
			};
		} catch (e) {
			if (opts.signal?.aborted) {
				await api.interrupt(cfg);
				throw new ImageBackendError('cancelled', 'Generation cancelled.');
			}
			throw e;
		} finally {
			closeSocket();
		}
	}
};
