/**
 * One generation model on one server: what Settings keeps for each image
 * model it can route to, and later each music or video model. A backend is
 * built from an entry rather than from the settings, so two entries of one
 * kind (two ComfyUI servers, two toolchest instances) work side by side.
 */

import { urlHost } from '#lib/utils/http.ts';

export interface GenerationEntry<B extends string, C> {
	/** Stable across edits: `crypto.randomUUID()`. */
	id: string;
	/** Shown in Settings, and what the chat model names. */
	name: string;
	backend: B;
	/** The server's address; empty for the bundled engine. */
	url: string;
	/** A named key from Settings → Inference → API Keys, or none. */
	keyId: string | null;
	/** What a request names: a checkpoint, an instance or a catalogue id. */
	model: string;
	/** Anything else one backend needs, such as ComfyUI's custom workflow. */
	options: Record<string, string>;
	/** What the last probe said it can do; null before one answered. */
	caps: C | null;
	capsAt: number | null;
	/** The user named it, so a probe leaves the name alone. */
	renamed: boolean;
	/**
	 * Turned off in Settings: kept, with its place in the list, but no tool,
	 * job or prompt uses it. Absent (on) in lists saved before the switch.
	 */
	disabled?: boolean;
}

/** `e` turned on or off; on drops the field, as lists saved before the switch have it. */
export function withEnabled<E extends { disabled?: boolean }>(e: E, on: boolean): E {
	if (!on) return { ...e, disabled: true };
	const rest = { ...e };
	delete rest.disabled;
	return rest;
}

/** The entries of `list` that are turned on, in order. */
export function enabledEntries<E extends { disabled?: boolean }>(list: readonly E[]): E[] {
	return list.filter((e) => !e.disabled);
}

/**
 * Which backend made something, for a tool's answer and its task card:
 * `label` and the server's host ("ComfyUI at asmodean:8188"), or `label`
 * alone when the entry has no address or the host already says it
 * ("OpenRouter").
 */
export function servedByOf(label: string, url: string): string {
	const host = urlHost(url.trim());
	if (!host || host.toLowerCase().includes(label.toLowerCase())) return label;
	return `${label} at ${host}`;
}

/** The fields that change what a backend built from `e` sends, as one string. */
export function entryConfigKey(e: GenerationEntry<string, unknown>): string {
	const options = Object.keys(e.options)
		.sort()
		.map((k) => [k, e.options[k]]);
	return JSON.stringify([e.backend, e.url.trim(), e.keyId, e.model.trim(), options]);
}

/**
 * `name` if no other entry has it; else `name (host)`; else `name 2`,
 * `name 3`, …. `taken` is every other entry's name.
 */
export function uniqueName(name: string, host: string, taken: readonly string[]): string {
	const used = new Set(taken);
	if (!used.has(name)) return name;
	if (host && !used.has(`${name} (${host})`)) return `${name} (${host})`;
	for (let n = 2; ; n++) {
		if (!used.has(`${name} ${n}`)) return `${name} ${n}`;
	}
}
