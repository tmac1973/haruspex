/**
 * OpenRouter API client — catalog fetch + key-status lookup.
 *
 * OpenRouter (https://openrouter.ai) is a cloud model router that exposes an
 * OpenAI-compatible `/v1/chat/completions` endpoint. Chat completions
 * themselves go through the existing `api.ts` transport (which already speaks
 * OpenAI shape + Bearer auth); this module only covers the two OpenRouter-
 * specific lookups the Settings form needs:
 *
 *   - `GET /api/v1/models` — the full model catalog (no auth, edge-cached).
 *     Returns per-model metadata (context length, input modalities, supported
 *     parameters, pricing, reasoning caps, deprecation date) that the generic
 *   `probe_inference_server` can't supply.
 *   - `GET /api/v1/key` — the caller's key status (credits remaining, free-tier
 *     limits). Requires the Bearer key.
 *
 * Both are plain `fetch()` from the frontend — OpenRouter is CORS-open and
 * there's no benefit to proxying through Rust. The catalog is cached in
 * `InferenceBackendConfig.openrouterCatalog` (see `stores/settings.ts`) with
 * a 24 h TTL; the form re-fetches on demand.
 */

import { readErrorText } from '$lib/utils/http';

/**
 * Default model after a catalog (re)load: keep the current selection if the
 * catalog still lists it, else `openrouter/auto`, else the first model.
 * Shared by the OpenRouter settings form and the per-job override.
 */
export function pickOpenRouterModel(
	models: OpenRouterModel[],
	currentId: string | null | undefined
): string {
	if (currentId && models.some((m) => m.id === currentId)) return currentId;
	const auto = models.find((m) => m.id === 'openrouter/auto');
	return auto ? auto.id : (models[0]?.id ?? '');
}

/** Context/vision capabilities read off a catalog model card. */
export function openRouterModelCaps(m: OpenRouterModel): {
	contextSize: number | null;
	vision: boolean;
} {
	return {
		contextSize:
			typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : null,
		vision: isOpenRouterVisionCapable(m)
	};
}

/** Base URL for the OpenRouter API (no trailing slash, no `/v1` suffix). */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

/** How long a cached catalog stays fresh before the form offers a refresh. */
export const OPENROUTER_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Attribution headers OpenRouter accepts on every request (optional but free
 * visibility for the project on their public leaderboard). Added to chat
 * completions in `api.ts` and to the catalog/key fetches here.
 */
export const OPENROUTER_ATTRIBUTION_HEADERS: Record<string, string> = {
	'HTTP-Referer': 'https://github.com/tmac1973/haruspex',
	'X-Title': 'Haruspex'
};

/** One model entry from `GET /api/v1/models`. Only the fields we use. */
export interface OpenRouterModel {
	id: string;
	name: string;
	/** Max context window in tokens. Drives compaction thresholds. */
	context_length: number;
	architecture: {
		input_modalities: string[];
		output_modalities: string[];
	};
	/** OpenAI-style param names this model accepts (e.g. `tools`, `reasoning`). */
	supported_parameters: string[];
	/** Per-token USD prices as strings; `"0"` means free. */
	pricing: {
		prompt: string;
		completion: string;
		request: string;
	};
	/** Present only for reasoning-capable models. */
	reasoning?: {
		supported_efforts: string[];
		default_effort: string;
		default_enabled: boolean;
		/** When true the model rejects `effort: "none"` — locked to reasoning. */
		mandatory: boolean;
	};
	/** Deprecation date (ISO) or null when the model is current. */
	expiration_date: string | null;
}

/** The shape of `GET /api/v1/key` — the caller's credit + limit status. */
export interface OpenRouterKeyStatus {
	label: string | null;
	/** Per-key credit cap, or null for uncapped. */
	limit: number | null;
	limit_remaining: number | null;
	limit_reset: string | null;
	/** Credits used in the current period. */
	usage: number;
	is_free_tier: boolean;
	usage_daily: number;
	usage_weekly: number;
	usage_monthly: number;
}

/**
 * Free-tier rate limits documented by OpenRouter. Surfaced in the form so the
 * user knows why a `:free` model request got a 429.
 */
export const FREE_MODEL_RPM = 20;
export const FREE_MODEL_NO_CREDITS_RPD = 50;
export const FREE_MODEL_HAS_CREDITS_RPD = 1000;

/** True when a model id is one of OpenRouter's free variants (`:free` suffix). */
export function isOpenRouterFreeModel(id: string): boolean {
	return id.endsWith(':free');
}

/** True when a model supports tool/function calling (drives the agent loop). */
export function isOpenRouterToolCapable(m: OpenRouterModel): boolean {
	return m.supported_parameters.includes('tools');
}

/** True when a model accepts image inputs. */
export function isOpenRouterVisionCapable(m: OpenRouterModel): boolean {
	return m.architecture.input_modalities.includes('image');
}

/**
 * Parse the raw `GET /api/v1/models` JSON into a typed, sorted catalog.
 * Models are sorted by name for a stable, alphabetical dropdown. Exported
 * for unit testing against a fixture.
 */
export function parseOpenRouterCatalog(data: unknown): OpenRouterModel[] {
	const arr = (data as { data?: unknown[] })?.data;
	if (!Array.isArray(arr)) return [];
	const models: OpenRouterModel[] = [];
	for (const raw of arr) {
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as Record<string, unknown>;
		const id = typeof r.id === 'string' ? r.id : null;
		const name = typeof r.name === 'string' ? r.name : id;
		if (!id) continue;
		const context_length =
			typeof r.context_length === 'number'
				? r.context_length
				: ((r.top_provider as { context_length?: number } | undefined)?.context_length ?? 0);
		const arch = (r.architecture ?? {}) as Record<string, unknown>;
		const supported = Array.isArray(r.supported_parameters)
			? (r.supported_parameters as string[])
			: [];
		const pricing = (r.pricing ?? {}) as Record<string, unknown>;
		const reasoning = parseReasoning(r.reasoning);
		const expiration = typeof r.expiration_date === 'string' ? r.expiration_date : null;
		models.push({
			id,
			name: name ?? id,
			context_length,
			architecture: {
				input_modalities: Array.isArray(arch.input_modalities)
					? (arch.input_modalities as string[])
					: [],
				output_modalities: Array.isArray(arch.output_modalities)
					? (arch.output_modalities as string[])
					: []
			},
			supported_parameters: supported,
			pricing: {
				prompt: typeof pricing.prompt === 'string' ? pricing.prompt : '0',
				completion: typeof pricing.completion === 'string' ? pricing.completion : '0',
				request: typeof pricing.request === 'string' ? pricing.request : '0'
			},
			reasoning,
			expiration_date: expiration
		});
	}
	models.sort((a, b) => a.name.localeCompare(b.name));
	return models;
}

function parseReasoning(r: unknown): OpenRouterModel['reasoning'] | undefined {
	if (!r || typeof r !== 'object') return undefined;
	const obj = r as Record<string, unknown>;
	const efforts = Array.isArray(obj.supported_efforts) ? (obj.supported_efforts as string[]) : [];
	if (efforts.length === 0) return undefined;
	return {
		supported_efforts: efforts,
		default_effort: typeof obj.default_effort === 'string' ? obj.default_effort : efforts[0],
		default_enabled: typeof obj.default_enabled === 'boolean' ? obj.default_enabled : true,
		mandatory: typeof obj.mandatory === 'boolean' ? obj.mandatory : false
	};
}

/** Parse `GET /api/v1/key` into the typed subset the form displays. */
export function parseOpenRouterKeyStatus(data: unknown): OpenRouterKeyStatus {
	const d = (data as { data?: Record<string, unknown> })?.data ?? {};
	const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
	return {
		label: typeof d.label === 'string' ? d.label : null,
		limit: typeof d.limit === 'number' ? d.limit : null,
		limit_remaining: typeof d.limit_remaining === 'number' ? d.limit_remaining : null,
		limit_reset: typeof d.limit_reset === 'string' ? d.limit_reset : null,
		usage: num(d.usage),
		is_free_tier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : false,
		usage_daily: num(d.usage_daily),
		usage_weekly: num(d.usage_weekly),
		usage_monthly: num(d.usage_monthly)
	};
}

/**
 * Fetch the full OpenRouter model catalog. No auth needed (edge-cached).
 * Throws on non-2xx or network failure; the caller surfaces the error.
 */
export async function fetchOpenRouterCatalog(signal?: AbortSignal): Promise<OpenRouterModel[]> {
	const res = await fetch(`${OPENROUTER_BASE_URL}/v1/models`, {
		headers: OPENROUTER_ATTRIBUTION_HEADERS,
		signal
	});
	if (!res.ok) {
		const text = await readErrorText(res);
		throw new Error(`OpenRouter catalog fetch failed (${res.status}): ${text}`);
	}
	const data = await res.json();
	return parseOpenRouterCatalog(data);
}

/**
 * Fetch the caller's key status (credits, limits). Requires the Bearer key.
 * Throws on non-2xx (401 = bad key, 402 = no credits) so the form can map
 * the error to a user-visible message.
 */
export async function fetchOpenRouterKeyStatus(
	apiKey: string,
	signal?: AbortSignal
): Promise<OpenRouterKeyStatus> {
	const res = await fetch(`${OPENROUTER_BASE_URL}/v1/key`, {
		headers: {
			Authorization: `Bearer ${apiKey.trim()}`,
			...OPENROUTER_ATTRIBUTION_HEADERS
		},
		signal
	});
	if (!res.ok) {
		const text = await readErrorText(res);
		throw new Error(`OpenRouter key check failed (${res.status}): ${text}`);
	}
	const data = await res.json();
	return parseOpenRouterKeyStatus(data);
}
