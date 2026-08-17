/**
 * Advanced per-job model behavior: the reasoning override, the sampling
 * source, and the capabilities discovered by the last probe of the job's
 * override server.
 *
 * Stored as opaque JSON in the `model_advanced` column — Rust never parses it,
 * the same contract `type_config` has. Parsing is deliberately defensive:
 * this JSON is on disk in user databases, and a shape change must degrade to
 * defaults rather than throw somewhere inside an unattended 3am run.
 *
 * Why the probe results live here rather than being re-derived: a per-job
 * override has no probe/catalog metadata at request time, so
 * `resolveOverrideDescriptor` used to fall back to matching the model id
 * against a hard-coded list of Qwen substrings. A model outside that list got
 * `reasoningMode: none` — no `enable_thinking` kwarg sent at all, and no way
 * for the job to turn reasoning off. The editor already probes the server and
 * receives its real capabilities; persisting them is what makes the toggle
 * work for any model.
 */

import type { RemoteReasoningCaps, RemoteSamplingCaps, SamplingParams } from '$lib/stores/settings';

/**
 * Where a job's sampling parameters come from.
 *
 * - `server` — send nothing. Every field omitted from the request body means
 *   the serving backend's own configuration wins outright. The right default
 *   whenever the server publishes its own recommendations.
 * - `profile` — the app's tuned profile: discovered presets layered over the
 *   built-in model-family values. The pre-existing behavior.
 * - `custom` — this job's hand-set values; blank fields are omitted, not
 *   back-filled, so clearing a field means "don't send it".
 */
export type SamplingSource = 'server' | 'profile' | 'custom';

/** Per-job reasoning mode: inherit the global setting, or force it either way. */
export type ReasoningMode = 'inherit' | 'on' | 'off';

/**
 * Per-job reasoning: whether to think, and how hard.
 *
 * Two axes because the model treats them as two — Qwen 3.8 reads its
 * `reasoning_effort` from inside the `enable_thinking` branch, and has no
 * "none" level to express off with.
 */
export interface ReasoningOverride {
	mode: ReasoningMode;
	/** null = inherit the global effort selection. */
	effort: string | null;
}

/** Capabilities read from the last successful probe of the override server. */
export interface DiscoveredCaps {
	reasoning: RemoteReasoningCaps | null;
	sampling: RemoteSamplingCaps | null;
}

export interface JobModelAdvanced {
	reasoning: ReasoningOverride;
	sampling: {
		source: SamplingSource;
		/** Only meaningful when `source === 'custom'`. */
		params: SamplingParams | null;
	};
	/** Null when the override server has never been probed. */
	discovered: DiscoveredCaps | null;
}

export function defaultModelAdvanced(): JobModelAdvanced {
	return {
		reasoning: { mode: 'inherit', effort: null },
		sampling: { source: 'profile', params: null },
		discovered: null
	};
}

/**
 * The sampling source a freshly-probed server should default to. A server
 * that publishes its own recommendations is the authority on them — adopting
 * `profile` there would send the app's built-in numbers back over the top of
 * values the operator deliberately configured.
 */
export function defaultSourceForCaps(caps: DiscoveredCaps | null): SamplingSource {
	return caps?.sampling ? 'server' : 'profile';
}

export function parseModelAdvanced(json: string | null | undefined): JobModelAdvanced {
	if (!json) return defaultModelAdvanced();
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(json);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return defaultModelAdvanced();
		}
		raw = parsed as Record<string, unknown>;
	} catch {
		return defaultModelAdvanced();
	}
	return {
		reasoning: parseReasoning(raw.reasoning),
		sampling: parseSampling(raw.sampling),
		discovered: parseDiscovered(raw.discovered)
	};
}

/**
 * Serialize for the `model_advanced` column. Returns null for an
 * all-defaults, never-probed config so an untouched job stores NULL rather
 * than a row of noise.
 */
export function serializeModelAdvanced(cfg: JobModelAdvanced): string | null {
	const isDefault =
		cfg.reasoning.mode === 'inherit' &&
		cfg.reasoning.effort === null &&
		cfg.sampling.source === 'profile' &&
		cfg.sampling.params === null &&
		cfg.discovered === null;
	if (isDefault) return null;
	return JSON.stringify({
		reasoning: cfg.reasoning,
		sampling: {
			source: cfg.sampling.source,
			// Custom params are meaningless under the other two sources; drop
			// them so a switch back to 'profile' can't resurrect stale numbers.
			params: cfg.sampling.source === 'custom' ? cfg.sampling.params : null
		},
		discovered: cfg.discovered
	});
}

/**
 * Accepts both shapes: the bare string this field used to be, and the
 * `{mode, effort}` object it is now. Jobs configured before effort existed are
 * sitting in user databases, and degrading one of them to `inherit` would
 * silently turn reasoning back on for a job whose owner turned it off.
 */
function parseReasoning(v: unknown): ReasoningOverride {
	if (typeof v === 'string') {
		return { mode: v === 'on' || v === 'off' ? v : 'inherit', effort: null };
	}
	if (!v || typeof v !== 'object') return { mode: 'inherit', effort: null };
	const raw = v as Record<string, unknown>;
	return {
		mode: raw.mode === 'on' || raw.mode === 'off' ? raw.mode : 'inherit',
		effort: typeof raw.effort === 'string' && raw.effort.length > 0 ? raw.effort : null
	};
}

function parseSampling(v: unknown): JobModelAdvanced['sampling'] {
	if (!v || typeof v !== 'object') return { source: 'profile', params: null };
	const raw = v as Record<string, unknown>;
	const source: SamplingSource =
		raw.source === 'server' || raw.source === 'custom' ? raw.source : 'profile';
	return { source, params: source === 'custom' ? parseSamplingParams(raw.params) : null };
}

/**
 * Only finite numbers survive. A field that is absent, null, a string, or NaN
 * becomes `undefined` — which `buildRequestBody` omits, so a malformed stored
 * value degrades to "let the server decide" rather than to `temperature: NaN`.
 */
export function parseSamplingParams(v: unknown): SamplingParams | null {
	if (!v || typeof v !== 'object') return null;
	const raw = v as Record<string, unknown>;
	const out: SamplingParams = {
		temperature: num(raw.temperature),
		top_p: num(raw.top_p),
		top_k: num(raw.top_k),
		min_p: num(raw.min_p),
		presence_penalty: num(raw.presence_penalty)
	};
	return Object.values(out).some((n) => n !== undefined) ? out : null;
}

function num(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function parseDiscovered(v: unknown): DiscoveredCaps | null {
	if (!v || typeof v !== 'object') return null;
	const raw = v as Record<string, unknown>;
	const reasoning = parseReasoningCaps(raw.reasoning);
	const sampling = parseSamplingCaps(raw.sampling);
	return reasoning || sampling ? { reasoning, sampling } : null;
}

function parseReasoningCaps(v: unknown): RemoteReasoningCaps | null {
	if (!v || typeof v !== 'object') return null;
	const raw = v as Record<string, unknown>;
	if (typeof raw.supported !== 'boolean') return null;
	// Non-string members are dropped rather than coerced: every surviving level
	// is sent to a template that raises on anything it doesn't recognize.
	const levels = Array.isArray(raw.effort_levels)
		? raw.effort_levels.filter((l): l is string => typeof l === 'string')
		: [];
	return {
		supported: raw.supported,
		default_enabled: raw.default_enabled === true,
		toggle: typeof raw.toggle === 'string' ? raw.toggle : 'none',
		kwarg: typeof raw.kwarg === 'string' ? raw.kwarg : null,
		effort_levels: levels.length > 0 ? levels : null,
		default_effort: typeof raw.default_effort === 'string' ? raw.default_effort : null
	};
}

function parseSamplingCaps(v: unknown): RemoteSamplingCaps | null {
	if (!v || typeof v !== 'object') return null;
	const raw = v as Record<string, unknown>;
	const presets = Array.isArray(raw.presets)
		? raw.presets
				.map((p) => {
					if (!p || typeof p !== 'object') return null;
					const entry = p as Record<string, unknown>;
					if (typeof entry.name !== 'string') return null;
					return { ...(parseSamplingParams(entry) ?? {}), name: entry.name };
				})
				.filter((p) => p !== null)
		: [];
	const def = parseSamplingParams(raw.default) ?? {};
	// A caps object with neither a default nor any preset carries no
	// information; treat it as "never probed" so the source default is honest.
	if (presets.length === 0 && Object.keys(def).length === 0) return null;
	return { default: def, presets };
}

/**
 * Plain-English description of what the 'profile' sampling source will
 * actually send, given the model's tuned family (null when the app has no
 * card values for it) and whether the server published its own
 * recommendations.
 *
 * Four genuinely different outcomes, and conflating them is how a control
 * ends up lying: with no family AND no server caps, 'profile' sends nothing
 * at all, making it identical to 'server'. An earlier version of this text
 * promised "the app's tuned values filling any gaps" in that case, when there
 * were no tuned values to fill anything with.
 *
 * Only llama-toolchest publishes sampling recommendations today — every other
 * probe path (stock llama-server, LM Studio, Lemonade, vLLM, Ollama) returns a
 * bare model list — so `hasServerCaps` is false for most users.
 */
export function describeSamplingProfile(family: string | null, hasServerCaps: boolean): string {
	if (hasServerCaps && family) {
		return `The server's published recommendations, picked per turn for thinking or coding mode, with the app's tuned ${family} values filling any parameter the server leaves unspecified.`;
	}
	if (hasServerCaps) {
		return "The server's published recommendations, picked per turn for thinking or coding mode. The app has no tuned values for this model, so anything the server leaves unspecified is omitted and its own default applies.";
	}
	if (family) {
		return `The app's tuned ${family} values, picked per turn for thinking or coding mode.`;
	}
	return 'The app has no tuned values for this model and the server published none, so nothing is sent — identical to Server defaults.';
}
