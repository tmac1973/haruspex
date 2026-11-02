/**
 * What a llama-toolchest server can generate, from its `/v1/models`: every
 * generation instance it runs is listed beside the chat models, with
 * `meta.kind` saying image, music or video, `meta.state` whether it can take
 * a request now, and `meta.api` which routes this build has (`images.jobs`
 * and so on). Shared by the image, music and video backends.
 */

import { getApiKeyValue } from '#lib/stores/settings.ts';
import { apiKeysReady } from '#lib/stores/apiKeySecrets.ts';
import { BACKEND_TIMEOUT_MS } from '#lib/utils/backendCall.ts';

export type GenerationKind = 'image' | 'music' | 'video';

/** What `/v1/models` lists: the kinds above, and upscalers, which serve the image backend. */
export type ListedKind = GenerationKind | 'upscale';

/** The settings fields that hold a toolchest server's named key. */
export type ApiKeyIdField =
	'imageToolchestApiKeyId' | 'musicToolchestApiKeyId' | 'videoGenToolchestApiKeyId';

/** What a request names, and what Settings shows about it. */
export interface ToolchestInstance {
	/** The instance id: what a request's `model` names. */
	id: string;
	modelSet: string;
	/** The catalogue recipe it runs; empty for a set the user put together. */
	recipe: string;
	capabilities: string[];
	/** `running` takes requests; anything else waits on the user in toolchest. */
	state: string;
	/** Routes this build has for it: `images.jobs`, `music.jobs`, … */
	api: string[];
	/** A music model's `task_type`s; empty from a build that lists none. */
	tasks: string[];
	/** How many pictures one edit takes; null when the build doesn't say. */
	maxEditImages: number | null;
	/** How many times larger an upscaler makes a picture; null when the set doesn't say. */
	scale: number | null;
	/** A video instance's defaults and limits; null for any other kind. */
	video: VideoLimits | null;
	licence: string;
	/** Null when the recipe isn't one whose licence Haruspex knows. */
	commercialUse: boolean | null;
}

/** What a video instance makes by default, and the most it can. */
export interface VideoLimits {
	defaultFps: number;
	defaultFrames: number;
	/** `WxH`. */
	defaultSize: string;
	/** Absent when the model set names no limit. */
	maxFrames: number | null;
	maxSize: string | null;
	/**
	 * Frames × width × height the instance was measured for: its GPU memory
	 * covers no more. Null from a build that doesn't say.
	 */
	maxPixelFrames: number | null;
}

/** The two families Haruspex knows, by toolchest recipe, as `image_models.rs` has them. */
const KNOWN: { match: RegExp; family: 'ming' | 'qwen21'; licence: string; commercial: boolean }[] =
	[
		{
			match: /^ming-image/,
			family: 'ming',
			licence: 'MIT — commercial use allowed.',
			commercial: true
		},
		{
			match: /^qwen-image-2(\.)?1/,
			family: 'qwen21',
			licence: 'Qwen Research License — research and evaluation only.',
			commercial: false
		}
	];

/** The catalogue family a recipe is, or null for one Haruspex doesn't know. */
export function familyOfRecipe(recipe: string): 'ming' | 'qwen21' | null {
	return KNOWN.find((k) => k.match.test(recipe))?.family ?? null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const num = (v: unknown): number | null =>
	typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

function videoLimits(v: unknown): VideoLimits | null {
	const o = obj(v);
	if (!Object.keys(o).length) return null;
	return {
		defaultFps: num(o.default_fps) ?? 24,
		defaultFrames: num(o.default_frames) ?? 33,
		defaultSize: str(o.default_size) || '832x480',
		maxFrames: num(o.max_frames),
		maxSize: str(o.max_size) || null,
		maxPixelFrames: num(o.measured_pixel_frames)
	};
}

/** Builds before `meta.api` existed had these routes and no others. */
const OLD_API: Record<ListedKind, string[]> = {
	image: ['images.sync'],
	music: ['music.jobs'],
	video: ['video.jobs'],
	// Upscalers came after `meta.api`, so a build always lists their route.
	upscale: []
};

/** A toolchest's generation instances of one kind, in the order it lists them. */
export function parseGenerationModels(json: unknown, kind: ListedKind): ToolchestInstance[] {
	const data = obj(json).data;
	if (!Array.isArray(data)) return [];
	return data
		.map(obj)
		.filter((m) => m.owned_by === 'llama-toolchest' && obj(m.meta).kind === kind)
		.map((m) => {
			const meta = obj(m.meta);
			const recipe = str(meta.recipe);
			const known = KNOWN.find((k) => k.match.test(recipe));
			return {
				id: str(m.id),
				modelSet: str(meta.model_set),
				recipe,
				capabilities: strings(meta.capabilities),
				state: str(meta.state) || 'unknown',
				api: Array.isArray(meta.api) ? strings(meta.api) : OLD_API[kind],
				tasks: strings(meta.tasks),
				maxEditImages: num(meta.max_edit_images),
				scale: num(meta.scale),
				video: kind === 'video' ? videoLimits(meta.video) : null,
				licence: known?.licence ?? 'unknown',
				commercialUse: known ? known.commercial : null
			};
		})
		.filter((i) => i.id !== '');
}

/** A saved key's value, read from the key store; empty for none. */
export async function toolchestKeyFor(apiKeyId: string | null): Promise<string> {
	if (!apiKeyId) return '';
	await apiKeysReady();
	return getApiKeyValue(apiKeyId) ?? '';
}

/**
 * A call for `comfy.rs`'s client, through `toolchest_json` or `toolchest_bytes`:
 * Rust's `ComfyCall`, with `timeout_ms` as the number `invoke` sends.
 */
export interface ToolchestCall {
	base_url: string;
	api_key: string;
	method: 'GET' | 'POST' | 'DELETE';
	path: string;
	body: unknown;
	timeout_ms: number;
	id: string | null;
}

export function toolchestCall(
	baseUrl: string,
	apiKey: string,
	method: 'GET' | 'POST' | 'DELETE',
	path: string,
	body?: unknown,
	timeoutMs = BACKEND_TIMEOUT_MS,
	id?: string
): ToolchestCall {
	return {
		base_url: baseUrl,
		api_key: apiKey,
		method,
		path,
		body: body ?? null,
		timeout_ms: timeoutMs,
		id: id ?? null
	};
}
