/**
 * What a llama-toolchest server can generate, from its `/v1/models`: every
 * generation instance it runs is listed beside the chat models, with
 * `meta.kind` saying image or music, `meta.state` whether it can take a
 * request now, and `meta.api` which routes this build has (`images.jobs`
 * and so on). Shared by the image backend and the music backend.
 */

import { getApiKeyValue } from '#lib/stores/settings.ts';
import { apiKeysReady } from '#lib/stores/apiKeySecrets.ts';

export type GenerationKind = 'image' | 'music';

/** The settings fields that hold a toolchest server's named key. */
export type ApiKeyIdField = 'imageToolchestApiKeyId';

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
	licence: string;
	/** Null when the recipe isn't one whose licence Haruspex knows. */
	commercialUse: boolean | null;
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

/** Builds before `meta.api` existed had these routes and no others. */
const OLD_API: Record<GenerationKind, string[]> = {
	image: ['images.sync'],
	music: ['music.jobs']
};

/** A toolchest's generation instances of one kind, in the order it lists them. */
export function parseGenerationModels(json: unknown, kind: GenerationKind): ToolchestInstance[] {
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
	timeoutMs = 30_000,
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
