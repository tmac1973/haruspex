/**
 * One generation model on one server: what Settings keeps for each image
 * model it can route to, and later each music or video model. A backend is
 * built from an entry rather than from the settings, so two entries of one
 * kind (two ComfyUI servers, two toolchest instances) work side by side.
 */

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
