/**
 * Lemonade's HTTP shapes: the requests this backend sends and what it reads
 * back, kept apart from the calls so they can be tested against responses
 * recorded from a real server (`fixtures/`, Lemonade 2026.43.3).
 *
 * Generation goes through Lemonade's OpenAI-style `/api/v1/images/generations`,
 * which forwards to the sd-server the `sd-cpp` recipe runs. That route has no
 * field for a start image, a mask or a strength — but sd-server reads native
 * parameters from a `<sd_cpp_extra_args>{…}</sd_cpp_extra_args>` block in the
 * prompt, takes the FIRST such block, and strips them all
 * (`examples/server/routes_openai.cpp`). Lemonade appends a block of its own
 * built from the model's saved options; ours goes first, so it wins whole and
 * carries everything: seed, size, sampler, and the clear start image and
 * strength that Ming's transparency needs.
 *
 * It cannot carry a real picture. sd-server finds the block with a `std::regex`
 * over the whole prompt, and a long block crashes it — no answer, then
 * Lemonade's watchdog resets it and the model reloads. Measured 2026-10-23
 * (sd-cpp `master-957-90e86d1`): 24 KB of base64 drew, 61 KB crashed, and so
 * did every seam-pass start image tried (220 KB as JPEG, 2.2 MB as PNG). A
 * 1024 clear canvas is 5.5 KB, so Ming's transparency fits; the seam pass does
 * not, which is why this backend does not tile (`backend.ts`).
 */

import { CLEAR_START_STRENGTH } from '#lib/image/local/adapter.ts';

/** Longest extras block sent: under the measured 24 KB that drew, with room. */
export const MAX_EXTRAS_CHARS = 20_000;

export const ROUTES = {
	health: '/api/v1/health',
	systemInfo: '/api/v1/system-info',
	models: '/api/v1/models?show_all=true',
	pull: '/api/v1/pull',
	downloads: '/api/v1/downloads',
	downloadsControl: '/api/v1/downloads/control',
	load: '/api/v1/load',
	remove: '/api/v1/delete',
	unload: '/api/v1/unload',
	generate: '/api/v1/images/generations',
	edits: '/api/v1/images/edits',
	upscale: '/api/v1/images/upscale',
	install: '/api/v1/install',
	options: (name: string) => `/api/v1/models/${encodeURIComponent(name)}/options`
} as const;

/** Lemonade answers with a model's id without the `user.` its name has. */
export function bareName(name: string): string {
	return name.replace(/^user\./, '');
}

// ---- Generation --------------------------------------------------------------

/** sd-server's native request fields, as far as this backend sets them. */
export interface SdExtras {
	seed: number;
	width: number;
	height: number;
	negative_prompt?: string;
	sample_params: {
		sample_steps: number;
		sample_method: string;
		guidance: { txt_cfg: number };
	};
	/** Base64 PNG; its alpha is kept. */
	init_image?: string;
	strength?: number;
}

export interface GenerationBody {
	model: string;
	prompt: string;
	size: string;
	seed: number;
	n: 1;
	response_format: 'b64_json';
}

export function buildGeneration(req: {
	model: string;
	prompt: string;
	negativePrompt?: string;
	seed: number;
	width: number;
	height: number;
	sampler: { name: string; steps: number; cfg: number };
	/** A transparent PNG of the request's size, base64. */
	clearStart?: string;
}): GenerationBody {
	const extras: SdExtras = {
		seed: req.seed,
		width: req.width,
		height: req.height,
		...(req.negativePrompt?.trim() ? { negative_prompt: req.negativePrompt.trim() } : {}),
		sample_params: {
			sample_steps: req.sampler.steps,
			sample_method: req.sampler.name,
			guidance: { txt_cfg: req.sampler.cfg }
		}
	};
	if (req.clearStart) {
		extras.init_image = req.clearStart;
		extras.strength = CLEAR_START_STRENGTH;
	}
	const block = JSON.stringify(extras);
	if (block.length > MAX_EXTRAS_CHARS) {
		// Refused here rather than crashing the user's server.
		throw new Error(
			`This request is too large for Lemonade (${block.length} characters of parameters; ` +
				`sd-server fails above about ${MAX_EXTRAS_CHARS}).`
		);
	}
	return {
		model: req.model,
		prompt: `<sd_cpp_extra_args>${block}</sd_cpp_extra_args> ${req.prompt}`,
		size: `${req.width}x${req.height}`,
		seed: req.seed,
		n: 1,
		response_format: 'b64_json'
	};
}

/**
 * The fields of an edit (`/api/v1/images/edits`), each a text part beside the
 * `image[]` pictures: the generation's, seed and sampler in the prompt's
 * extras block as there. The pictures travel as file parts, not inside the
 * prompt, so the size limit on that block (above) doesn't reach them.
 */
export function buildEditFields(
	req: Omit<Parameters<typeof buildGeneration>[0], 'clearStart'>
): Record<string, string> {
	const body = buildGeneration(req);
	return {
		model: body.model,
		prompt: body.prompt,
		size: body.size,
		n: '1',
		response_format: body.response_format
	};
}

/** Lemonade's Real-ESRGAN, which `/api/v1/images/upscale` runs on sd-cpp. */
export const UPSCALER = 'RealESRGAN-x4plus';

/** Lemonade's own error sentence from a refusal's body, when it has one. */
export function errorMessage(body: string): string | null {
	try {
		const msg = (JSON.parse(body) as { error?: { message?: unknown } })?.error?.message;
		return typeof msg === 'string' && msg ? msg : null;
	} catch {
		return null;
	}
}

// ---- Probe -------------------------------------------------------------------

export interface ServerState {
	version: string;
	/** The GPU it would run on, by name, when it reports one. */
	gpu: string | null;
	/** Where its model files live, for the tokenizer's path. */
	storage: string | null;
	/**
	 * Can the sd-cpp recipe run here at all, on what, and is that engine
	 * installed yet (Lemonade installs it on request, `/api/v1/install`).
	 */
	sdcpp: { usable: boolean; backend: string | null; installed: boolean };
	/** Image model loaded now, without `user.`. */
	loadedImage: string | null;
	/** Registered models whose files are all down, without `user.`. */
	downloaded: Set<string>;
	/** Of those, the ones with vision weights (`llm_vision`), which edit. */
	edits: Set<string>;
	/** The upscaler (`UPSCALER`) is installed. */
	upscaler: boolean;
	/** Downloaded models whose saved `sdcpp_args` an older Haruspex wrote (`STALE_ARGS`). */
	stale: Set<string>;
}

/**
 * Saved `sdcpp_args` from before Ming lost `--backend te=cpu` on Lemonade:
 * its newer sd-server then put the rest of Ming on an integrated GPU, if the
 * machine had one (`lemonade.rs`, `lemonade_options`). Rewritten before use.
 */
export const STALE_ARGS = /--backend\s+te=cpu/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function readServer(health: unknown, systemInfo: unknown, models: unknown): ServerState {
	const h = obj(health);
	const si = obj(systemInfo);
	const devices = obj(si.devices);
	const gpus = [...asArray(devices.amd_gpu), ...asArray(devices.nvidia_gpu)].map(obj);
	const gpu = gpus.find((g) => g.available === true);

	const recipe = obj(obj(si.recipes)['sd-cpp']);
	const backends = obj(recipe.backends);
	const usableOn = (name: string) => {
		const state = str(obj(backends[name]).state);
		return state === 'installed' || state === 'installable';
	};
	const preferred = str(recipe.default_backend);
	const backend =
		preferred && usableOn(preferred) ? preferred : (Object.keys(backends).find(usableOn) ?? null);

	const loaded = asArray(h.all_models_loaded)
		.map(obj)
		.find((m) => m.type === 'image');
	const down = asArray(obj(models).data)
		.map(obj)
		.filter((m) => m.downloaded === true);
	const named = (ms: Json[]) => new Set(ms.map((m) => bareName(str(m.id) ?? '')));

	return {
		version: str(h.version) ?? 'unknown version',
		gpu: gpu ? str(gpu.name) : null,
		storage: str(obj(si.model_storage).path),
		sdcpp: {
			usable: backend !== null,
			backend,
			installed: backend !== null && str(obj(backends[backend]).state) === 'installed'
		},
		loadedImage: loaded ? bareName(str(loaded.model_name) ?? '') || null : null,
		downloaded: named(down),
		edits: named(down.filter((m) => 'llm_vision' in obj(m.checkpoints))),
		upscaler: down.some((m) => str(m.id) === UPSCALER),
		stale: named(down.filter((m) => STALE_ARGS.test(str(obj(m.recipe_options).sdcpp_args) ?? '')))
	};
}

function asArray(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

// ---- Install -----------------------------------------------------------------

/** One server-owned download job, as `/api/v1/downloads` lists it. */
export interface DownloadJob {
	id: string;
	status: 'downloading' | 'paused' | 'cancelled' | 'completed' | 'error' | string;
	running: boolean;
	complete: boolean;
	file: string;
	fileIndex: number;
	totalFiles: number;
	/** Across the whole job. */
	downloaded: number;
	total: number;
	error: string | null;
}

/** The job id Lemonade gives a model's download. */
export function jobId(name: string): string {
	return `model:${name}`;
}

export function readJob(v: unknown): DownloadJob | null {
	const j = obj(v);
	const id = str(j.id);
	if (!id) return null;
	const num = (k: string) => (typeof j[k] === 'number' ? (j[k] as number) : 0);
	return {
		id,
		status: str(j.status) ?? 'downloading',
		running: j.running === true,
		complete: j.complete === true,
		file: str(j.file) ?? '',
		fileIndex: num('file_index'),
		totalFiles: num('total_files'),
		downloaded: num('cumulative_bytes_downloaded') || num('overall_bytes_downloaded'),
		total: num('total_download_size'),
		error: str(j.error)
	};
}

/** The job for `name` in a `/api/v1/downloads` answer, by either form of its name. */
export function findJob(list: unknown, name: string): DownloadJob | null {
	const ids = new Set([jobId(name), jobId(bareName(name))]);
	for (const v of asArray(list)) {
		const job = readJob(v);
		if (job && ids.has(job.id)) return job;
	}
	return null;
}
