/**
 * OpenRouter's images API as data: the model list (`GET /v1/images/models`),
 * what one model can do, the request body for one picture, and what a model
 * costs (`GET /v1/images/models/{id}/endpoints`). No calls are made here;
 * `./backend.ts` makes them.
 *
 * A model takes an aspect ratio and a size tier, not pixels, so a request is
 * sent as the nearest of each it lists and the answer is fitted to the size
 * asked for afterwards (`image_fit_cover`).
 */

import type { ModelOption } from '#lib/image/backend.ts';
import type { ImageBackendCapabilities } from '#lib/image/types.ts';

/** One parameter a model takes, as the list describes it. */
export type ParamShape =
	| { type: 'enum'; values: string[] }
	| { type: 'range'; min: number; max: number }
	| { type: 'boolean' };

/** One model from `GET /v1/images/models`: only the fields read here. */
export interface OpenRouterImageModel {
	id: string;
	name: string;
	params: Record<string, ParamShape>;
}

function paramShape(raw: unknown): ParamShape | null {
	const p = raw as { type?: unknown; values?: unknown; min?: unknown; max?: unknown } | null;
	if (p?.type === 'enum' && Array.isArray(p.values)) {
		return { type: 'enum', values: p.values.filter((v): v is string => typeof v === 'string') };
	}
	if (p?.type === 'range' && typeof p.min === 'number' && typeof p.max === 'number') {
		return { type: 'range', min: p.min, max: p.max };
	}
	if (p?.type === 'boolean') return { type: 'boolean' };
	return null;
}

/** The list's models, each with the parameters it takes; anything malformed is left out. */
export function parseImageModels(payload: unknown): OpenRouterImageModel[] {
	const rows = (payload as { data?: unknown } | null)?.data;
	if (!Array.isArray(rows)) return [];
	const out: OpenRouterImageModel[] = [];
	for (const row of rows) {
		const r = (row ?? {}) as { id?: unknown; name?: unknown; supported_parameters?: unknown };
		if (typeof r.id !== 'string' || !r.id) continue;
		const params: Record<string, ParamShape> = {};
		const raw = r.supported_parameters;
		if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
			for (const [k, v] of Object.entries(raw)) {
				const shape = paramShape(v);
				if (shape) params[k] = shape;
			}
		}
		out.push({ id: r.id, name: typeof r.name === 'string' && r.name ? r.name : r.id, params });
	}
	return out;
}

function enumOf(m: OpenRouterImageModel, key: string): string[] | null {
	const p = m.params[key];
	return p?.type === 'enum' ? p.values : null;
}

function rangeOf(m: OpenRouterImageModel, key: string): { min: number; max: number } | null {
	const p = m.params[key];
	return p?.type === 'range' ? p : null;
}

/**
 * The model can be used here: it draws from a prompt alone (an edit-only
 * model needs a picture every time) and returns a raster picture (a vector
 * model's SVG can't be decoded).
 */
export function drawsPictures(m: OpenRouterImageModel): boolean {
	const refs = rangeOf(m, 'input_references');
	if (refs && refs.min > 0) return false;
	const formats = enumOf(m, 'output_format');
	return !formats || formats.some((f) => f !== 'svg');
}

/** The models Settings offers, by name. */
export function modelOptions(models: OpenRouterImageModel[]): ModelOption[] {
	return models
		.filter(drawsPictures)
		.map((m) => ({ name: m.id, label: m.name }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

/** What `m` can do: draw, edit when it takes pictures, transparency when it says so. */
export function capabilitiesOf(m: OpenRouterImageModel): ImageBackendCapabilities {
	const refs = rangeOf(m, 'input_references');
	const most = refs ? Math.max(0, Math.floor(refs.max)) : 0;
	return {
		transparency: !!enumOf(m, 'background')?.includes('transparent'),
		seamlessTiling: false,
		loras: false,
		maxLoras: 0,
		edit: most > 0,
		maxEditImages: most,
		upscale: false,
		inpaint: false
	};
}

/** `"16:9"` as 16/9; null for `auto` or anything else. */
function ratioOf(s: string): number | null {
	const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(s);
	if (!m) return null;
	const [w, h] = [Number(m[1]), Number(m[2])];
	return w > 0 && h > 0 ? w / h : null;
}

/** The listed aspect ratio nearest `width` × `height`, or null when none is listed. */
export function nearestAspectRatio(values: string[], width: number, height: number): string | null {
	const want = Math.log(width / height);
	let best: string | null = null;
	let gap = Infinity;
	for (const v of values) {
		const r = ratioOf(v);
		if (r === null) continue;
		const d = Math.abs(Math.log(r) - want);
		if (d < gap) [best, gap] = [v, d];
	}
	return best;
}

/** The long side each size tier draws at. */
const TIER_PIXELS: Record<string, number> = {
	'512': 512,
	'768': 768,
	'1K': 1024,
	'1.5K': 1536,
	'2K': 2048,
	'4K': 4096
};

/**
 * The smallest listed tier whose long side reaches `longSide`, else the
 * largest; null when none is one this knows. Drawing larger and scaling down
 * keeps detail, where drawing smaller would blur.
 */
export function nearestResolution(values: string[], longSide: number): string | null {
	const known = values
		.filter((v) => v in TIER_PIXELS)
		.sort((a, b) => TIER_PIXELS[a] - TIER_PIXELS[b]);
	return known.find((v) => TIER_PIXELS[v] >= longSide) ?? known.at(-1) ?? null;
}

/** What one picture is sent with. */
export interface DrawRequest {
	model: string;
	prompt: string;
	width: number;
	height: number;
	seed: number;
	transparent: boolean;
	/** Data URLs of the pictures to edit, in order. */
	references: string[];
}

/** The body of `POST /v1/images` for `req` on `m`: only what `m` lists is sent. */
export function buildImageBody(m: OpenRouterImageModel, req: DrawRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: req.model,
		prompt: req.prompt,
		response_format: 'b64_json'
	};
	const ratios = enumOf(m, 'aspect_ratio');
	const ratio = ratios && nearestAspectRatio(ratios, req.width, req.height);
	if (ratio) body.aspect_ratio = ratio;
	const tiers = enumOf(m, 'resolution');
	const tier = tiers && nearestResolution(tiers, Math.max(req.width, req.height));
	if (tier) body.resolution = tier;
	// PNG keeps the alpha a transparent picture needs, and isn't lossy.
	if (enumOf(m, 'output_format')?.includes('png')) body.output_format = 'png';
	if (req.transparent && enumOf(m, 'background')?.includes('transparent')) {
		body.background = 'transparent';
	}
	if (m.params.seed) body.seed = req.seed;
	if (req.references.length > 0) {
		body.input_references = req.references.map((url) => ({
			type: 'image_url',
			image_url: { url }
		}));
	}
	return body;
}

/** The pictures in an answer, as base64, in order. */
export function picturesFrom(payload: unknown): string[] {
	const data = (payload as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return [];
	return data
		.map((d) => (d as { b64_json?: unknown })?.b64_json)
		.filter((b): b is string => typeof b === 'string' && b.length > 0);
}

/** What the answer says it cost, in US dollars, when it says. */
export function costOf(payload: unknown): number | null {
	const cost = (payload as { usage?: { cost?: unknown } } | null)?.usage?.cost;
	return typeof cost === 'number' && Number.isFinite(cost) ? cost : null;
}

/** `$0.018`, `$0.13`: a price to the cent, or to two significant figures below one. */
export function formatUsd(n: number): string {
	if (n >= 1) return `$${n.toFixed(2)}`;
	return `$${Number(n.toPrecision(2))}`;
}

/**
 * A model's price in a few words, from its first endpoint's `pricing`: per
 * picture where it is so priced (the cheapest variant when there are
 * several), per megapixel, else "priced by token". Null when the list has
 * no output price.
 */
export function priceLine(payload: unknown): string | null {
	const endpoints = (payload as { endpoints?: unknown } | null)?.endpoints;
	if (!Array.isArray(endpoints) || endpoints.length === 0) return null;
	const pricing = (endpoints[0] as { pricing?: unknown })?.pricing;
	if (!Array.isArray(pricing)) return null;
	const out = pricing
		.map((p) => p as { billable?: unknown; unit?: unknown; cost_usd?: unknown })
		.filter((p) => p.billable === 'output_image' && typeof p.cost_usd === 'number');
	const cheapest = (unit: string) => {
		const costs = out.filter((p) => p.unit === unit).map((p) => p.cost_usd as number);
		return costs.length ? Math.min(...costs) : null;
	};
	const each = cheapest('image');
	if (each !== null) return each === 0 ? 'free' : `${formatUsd(each)} a picture`;
	const mp = cheapest('megapixel');
	if (mp !== null) return `${formatUsd(mp)} a megapixel`;
	return out.some((p) => p.unit === 'token') ? 'priced by token' : null;
}

/** The MIME type of a picture's bytes, from its first bytes; PNG when unknown. */
export function mimeOf(bytes: Uint8Array): string {
	const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x);
	if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
	if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
	return 'image/png';
}
