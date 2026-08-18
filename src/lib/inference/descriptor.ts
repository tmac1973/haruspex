/**
 * Backend provider descriptor — ONE resolved, self-contained description of
 * the inference backend a request (or a whole agent turn) targets.
 *
 * `resolveBackendDescriptor` is the only place allowed to read the
 * `inferenceBackend` settings mode, OpenRouter catalog metadata, probe-derived
 * capability fields, and per-job `BackendOverride`s. Request-path code
 * (api.ts routing, sampling/template-kwarg resolution, the agent loop, the
 * inference queue) consumes the descriptor instead of branching on mode
 * strings — so a capability quirk like the Qwen-tuned sampling profile can
 * never again leak to a backend it wasn't resolved for (#172).
 *
 * The `'remote'` pseudo server status in `stores/server.svelte.ts` is NOT
 * part of this seam: it's a UI badge concern only.
 */

import type { BackendOverride } from '$lib/api';
import type { OpenRouterModel } from '$lib/openrouter';
import { PORTS, baseUrl } from '$lib/ports';
import {
	getActiveLocalModelFilename,
	getApiKeyValue,
	getSettings,
	resolveEffort,
	type AppSettings,
	type InferenceBackendConfig,
	type QwenSamplingFamily,
	type RemoteReasoningCaps,
	type RemoteSamplingCaps
} from '$lib/stores/settings';

export type BackendKind = 'local' | 'remote' | 'openrouter';

/**
 * How the backend's reasoning / "thinking" mode is driven on the wire.
 *
 * - `template-kwarg`: llama.cpp-style `chat_template_kwargs` toggle (Qwen's
 *   `enable_thinking`, or the exact kwarg a llama-toolchest probe reported).
 * - `openrouter-effort`: OpenRouter's `{ reasoning: { effort } }` request
 *   param. `effort` is already resolved (user selection falling back to the
 *   model's default); `mandatory` mirrors the catalog flag — a mandatory
 *   model rejects `effort: "none"`.
 * - `none`: no known reasoning control — send nothing.
 */
export type ReasoningMode =
	| { kind: 'none' }
	| { kind: 'template-kwarg'; kwarg: string }
	| { kind: 'openrouter-effort'; effort: string; mandatory: boolean };

/**
 * How hard the model should think, when it exposes that as a separate axis
 * from on/off. Qwen 3.8's template reads a `reasoning_effort` variable from
 * *inside* its `enable_thinking` branch, so effort is an addition to the
 * thinking kwarg, never a replacement for it — and it has no `none` level.
 *
 * `levels` is the model's own vocabulary, and it is not advisory: Qwen 3.8's
 * template calls `raise_exception` for any value outside
 * `('xhigh', 'medium', 'low')`, which llama-server returns as a 500 for the
 * whole request. Every value sent on the wire must come from this list —
 * see `resolveEffort` in `stores/settings`.
 */
export interface EffortCaps {
	/** How the level travels: a chat-template kwarg, or OpenRouter's param. */
	transport: 'template-kwarg' | 'openrouter';
	/** Kwarg name for `template-kwarg` transport; null for OpenRouter. */
	kwarg: string | null;
	/** Exactly the levels this model accepts, in display order. */
	levels: string[];
	/** What the model does when no level is sent — labels the default option. */
	modelDefault: string | null;
	/** OpenRouter only: model always reasons, rejects `none`, effort locked. */
	mandatory: boolean;
}

/**
 * Every effort level any backend we know about accepts, cheapest first — the
 * union of Qwen 3.8's `low`/`medium`/`xhigh` and the `low`/`medium`/`high`
 * most OpenRouter reasoning models publish.
 *
 * Only for populating the Settings control when the *active* model publishes
 * no vocabulary of its own, so the user can still express a standing
 * preference that applies wherever it's understood. Never a source of truth
 * for what to send: `resolveEffort` validates against the active model's
 * advertised levels, so a level from this list that the model doesn't accept
 * is dropped rather than sent. `none` is deliberately absent — turning
 * reasoning off is the `thinkingEnabled` toggle's job, and Qwen 3.8 has no
 * such level.
 */
export const KNOWN_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];

/**
 * Effort vocabulary for the models that ship one. Qwen 3.5 and 3.6 templates
 * have no `reasoning_effort` variable at all — only `enable_thinking` — so
 * they are deliberately absent rather than listed with an empty vocabulary.
 */
const QWEN_38_EFFORT: EffortCaps = {
	transport: 'template-kwarg',
	kwarg: 'reasoning_effort',
	// Order is the template's own: cheapest first, its default last.
	levels: ['low', 'medium', 'xhigh'],
	modelDefault: 'xhigh',
	mandatory: false
};

export interface BackendDescriptor {
	kind: BackendKind;
	/** Base URL (no trailing slash, no /v1 suffix). Sidecar URL for local. */
	baseUrl: string;
	/** Resolved Bearer token (key-store reference wins over inline). */
	apiKey?: string;
	/** Model id sent in requests; 'default' placeholder when unset/local. */
	modelId: string;
	/** Context window (tokens) compaction/trimming should budget against. */
	contextSize: number;
	/** Whether the backend's model accepts image input. */
	vision: boolean;
	/**
	 * True when the tuned Qwen sampling profile AND the Qwen
	 * `enable_thinking` chat-template kwarg apply. Local models (all from the
	 * managed Qwen lineup — unrecognized local imports keep the default
	 * profile, preserving pre-descriptor behavior) and positively-identified
	 * remote Qwen ids. Nothing outside the resolver may test model names for
	 * this purpose.
	 */
	qwenTuning: boolean;
	/** Which tuned profile applies. Non-null iff `qwenTuning`. */
	samplingFamily: QwenSamplingFamily | null;
	/**
	 * Sampling recommendations discovered from the server (llama-toolchest
	 * probe). Overrides the built-in profiles when present; null when the
	 * backend was never probed, or its probe reported none.
	 */
	discoveredSampling: RemoteSamplingCaps | null;
	reasoningMode: ReasoningMode;
	/**
	 * Whether the model exposes a togglable reasoning mode at all. Drives the
	 * Settings "Reasoning mode" toggle visibility. Broader than
	 * `reasoningMode.kind !== 'none'`: a toolchest model can report a
	 * reasoning mechanism we can't drive via chat_template_kwargs.
	 */
	reasoningSupported: boolean;
	/**
	 * The model's effort vocabulary, or null when it has none — which is the
	 * case for most models, and is what hides the effort selector. Independent
	 * of `reasoningSupported`: a model can be togglable with no effort levels
	 * (every Qwen 3.5/3.6) or advertise a mechanism whose levels the server
	 * never enumerated (a toolchest model reporting bare `reasoning_effort`).
	 */
	reasoningEffort: EffortCaps | null;
	/** Whether the inference queue may admit parallel turns on this backend's lane. */
	allowParallel: boolean;
	/**
	 * How many turns this backend will genuinely run at once, when it says so.
	 * `null` means unknown — treated as unbounded, which is right for a hosted
	 * API whose concurrency is not ours to model, and wrong for a self-hosted
	 * server with a fixed slot count. Only meaningful when `allowParallel`.
	 */
	parallelSlots: number | null;
}

/** What a recognized model identity implies. One entry per model shape. */
interface ModelTraits {
	family: QwenSamplingFamily;
	/** Null when the model's template exposes no effort levels. */
	effort: EffortCaps | null;
}

/**
 * Model ids arrive in many spellings — `Qwen3.8-27B`, `qwen-3.8-27b`,
 * `unsloth-Qwen3.8-27B.IQ4_NL`, a bare GGUF filename. Normalizing away case
 * and separators means one pattern per model instead of one per spelling,
 * which is how a `qwen3.8` id previously matched none of the hand-written
 * `includes()` arms and silently lost both its tuned sampling and its
 * reasoning control (#195).
 */
function normalizeId(id: string): string {
	return id.toLowerCase().replace(/[.\-_ ]/g, '');
}

/**
 * Ordered: the dense-27B patterns must come before the generic family ones,
 * since `qwen38` is a prefix of `qwen3827b`.
 *
 * The dense 27B is the one model whose published thinking/general
 * presence_penalty differs (0.0 vs 1.5), so it gets its own profile;
 * everything else in the lineup (3.5 4B/9B, 3.6 35B-A3B) shares one.
 */
const MODEL_TRAITS: readonly (readonly [string, ModelTraits])[] = [
	['qwen3827b', { family: 'qwen-dense-27b', effort: QWEN_38_EFFORT }],
	['qwen3627b', { family: 'qwen-dense-27b', effort: null }],
	['qwen38', { family: 'qwen3.5', effort: QWEN_38_EFFORT }],
	['qwen36', { family: 'qwen3.5', effort: null }],
	['qwen35', { family: 'qwen3.5', effort: null }]
];

/**
 * Map a model identity (local GGUF filename or remote model ID) to its
 * traits. Returns null when the model isn't from a recognized lineup. This is
 * the ONLY model-name sniffing in the codebase; it feeds the resolver and
 * nothing else.
 */
function modelTraitsFromId(id: string | null | undefined): ModelTraits | null {
	if (!id) return null;
	const normalized = normalizeId(id);
	return MODEL_TRAITS.find(([pattern]) => normalized.includes(pattern))?.[1] ?? null;
}

/** Local models all come from the managed Qwen lineup — an unrecognized
 *  filename still gets the default profile (pre-descriptor behavior). */
const LOCAL_DEFAULT_FAMILY: QwenSamplingFamily = 'qwen3.5';

/** True when a base URL points at openrouter.ai (heuristic — host match). */
function isOpenRouterUrl(url: string): boolean {
	try {
		return new URL(url).hostname === 'openrouter.ai';
	} catch {
		return false;
	}
}

/** Trim whitespace and trailing slashes off a configured base URL. */
function normalizeBaseUrl(url: string | null | undefined): string {
	return (url ?? '').trim().replace(/\/+$/, '');
}

/** Resolve key material: key-store reference wins over the inline legacy key. */
function resolveApiKey(
	apiKeyId: string | null | undefined,
	inlineKey: string | null | undefined
): string | undefined {
	const key = (getApiKeyValue(apiKeyId) ?? inlineKey ?? '').trim();
	return key.length > 0 ? key : undefined;
}

/**
 * The context window the GLOBAL backend implies (`remoteContextSize` when the
 * mode is remote and a probed/manual value exists, else the local setting).
 * Also the fallback for overrides that don't carry their own size.
 */
function globalContextSize(settings: AppSettings): number {
	const inf = settings.inferenceBackend;
	if (
		inf.mode === 'remote' &&
		typeof inf.remoteContextSize === 'number' &&
		inf.remoteContextSize > 0
	) {
		return inf.remoteContextSize;
	}
	return settings.contextSize;
}

/**
 * Vision capability of the GLOBAL backend: local llama-server always can;
 * a remote backend is assumed capable unless explicitly marked otherwise.
 */
function globalVision(settings: AppSettings): boolean {
	const inf = settings.inferenceBackend;
	return inf.mode === 'remote' ? inf.remoteVisionSupported !== false : true;
}

/**
 * Resolve the active backend into a descriptor. Pure function of the current
 * settings snapshot and the optional per-request override; no caching.
 *
 * - No override → the Settings backend (local sidecar, self-hosted remote,
 *   or OpenRouter). Remote mode with a blank URL resolves as local, matching
 *   the request routing.
 * - Override with a non-blank base URL → a descriptor built from the
 *   override's own fields. Model quirks (Qwen tuning, template kwargs,
 *   discovered sampling, OpenRouter reasoning effort) are resolved from the
 *   override's own data — its probe results when it carries them, else its
 *   model id — and never inherited from the global backend, so a job pointed
 *   at server X can't pick up server Y's tuning. Context size and vision fall
 *   back to the global values when the override doesn't carry its own
 *   (matching the pre-descriptor job runner).
 */
export function resolveBackendDescriptor(override?: BackendOverride): BackendDescriptor {
	const settings = getSettings();
	if (override && override.baseUrl.trim().length > 0) {
		return resolveOverrideDescriptor(settings, override);
	}
	const inf = settings.inferenceBackend;
	const remoteBase = inf.mode === 'remote' ? normalizeBaseUrl(inf.remoteBaseUrl) : '';
	if (!remoteBase) return resolveLocalDescriptor(settings);
	return resolveRemoteDescriptor(settings, inf, remoteBase);
}

function resolveLocalDescriptor(settings: AppSettings): BackendDescriptor {
	const traits = modelTraitsFromId(getActiveLocalModelFilename() || null);
	const family = traits?.family ?? LOCAL_DEFAULT_FAMILY;
	return {
		kind: 'local',
		baseUrl: baseUrl(PORTS.llama),
		apiKey: undefined,
		// llama-server serves a single model and ignores the name.
		modelId: 'default',
		contextSize: globalContextSize(settings),
		vision: globalVision(settings),
		qwenTuning: true,
		samplingFamily: family,
		discoveredSampling: null,
		reasoningMode: { kind: 'template-kwarg', kwarg: 'enable_thinking' },
		reasoningSupported: true,
		// An unrecognized local GGUF keeps the default sampling family (see
		// LOCAL_DEFAULT_FAMILY) but gets NO effort levels — a family is a guess
		// about which tuned numbers fit, whereas an effort level is a string the
		// model's template either accepts or throws on.
		reasoningEffort: traits?.effort ?? null,
		allowParallel: false,
		parallelSlots: 1
	};
}

/**
 * Effort vocabulary for a chat-template backend: what the server enumerated,
 * falling back to what the model id implies.
 *
 * A server that names `reasoning_effort` without listing its levels has given
 * us a mechanism and no vocabulary. The id table is the only other source, and
 * when that misses too the answer is null — never a guessed list. Sending a
 * level the template doesn't recognize is not a degraded response, it is a
 * raised exception and a 500.
 */
function effortFromCaps(
	caps: RemoteReasoningCaps | null,
	traits: ModelTraits | null
): EffortCaps | null {
	const levels = caps?.effort_levels ?? [];
	if (caps?.supported && levels.length > 0) {
		return {
			transport: 'template-kwarg',
			kwarg:
				caps.toggle === 'reasoning_effort'
					? (caps.kwarg ?? 'reasoning_effort')
					: 'reasoning_effort',
			levels,
			modelDefault: caps.default_effort ?? null,
			mandatory: false
		};
	}
	return traits?.effort ?? null;
}

/** OpenRouter's catalog already carries the whole vocabulary. */
function effortFromOpenRouter(model: OpenRouterModel | null): EffortCaps | null {
	if (!model?.reasoning) return null;
	return {
		transport: 'openrouter',
		kwarg: null,
		levels: model.reasoning.supported_efforts,
		modelDefault: model.reasoning.default_effort,
		mandatory: model.reasoning.mandatory
	};
}

function resolveRemoteDescriptor(
	settings: AppSettings,
	inf: InferenceBackendConfig,
	remoteBase: string
): BackendDescriptor {
	const openrouter = inf.remoteBackendKind === 'openrouter' || isOpenRouterUrl(remoteBase);
	const traits = modelTraitsFromId(inf.remoteModelId);
	const family = traits?.family ?? null;
	// Discovered capabilities are trusted only from a llama-toolchest probe;
	// every other backend kind keeps the built-in behavior.
	const toolchest = inf.remoteBackendKind === 'llama-toolchest';

	let reasoningMode: ReasoningMode = { kind: 'none' };
	let reasoningSupported = false;
	let reasoningEffort: EffortCaps | null = null;
	if (openrouter) {
		// OpenRouter reasoning is driven by the `reasoning.effort` request
		// param, never llama.cpp chat_template_kwargs.
		const model = inf.openrouterCatalog?.find((m) => m.id === inf.remoteModelId) ?? null;
		reasoningEffort = effortFromOpenRouter(model);
		if (model?.reasoning) {
			reasoningSupported = true;
			reasoningMode = {
				kind: 'openrouter-effort',
				effort: resolveEffort(reasoningEffort) ?? model.reasoning.default_effort,
				mandatory: model.reasoning.mandatory
			};
		}
	} else if (toolchest && inf.remoteReasoning) {
		// Honor the model's discovered reasoning shape: drive the reported
		// kwarg, or send nothing when the toggle isn't chat_template_kwargs.
		const caps = inf.remoteReasoning;
		reasoningSupported = caps.supported;
		if (caps.supported && caps.toggle === 'chat_template_kwargs' && caps.kwarg) {
			reasoningMode = { kind: 'template-kwarg', kwarg: caps.kwarg };
		}
		reasoningEffort = effortFromCaps(caps, traits);
	} else if (family !== null) {
		// A recognized remote Qwen wants the same enable_thinking kwarg as the
		// managed local lineup; an unrecognized remote model gets nothing.
		reasoningSupported = true;
		reasoningMode = { kind: 'template-kwarg', kwarg: 'enable_thinking' };
		reasoningEffort = traits?.effort ?? null;
	}

	return {
		kind: openrouter ? 'openrouter' : 'remote',
		baseUrl: remoteBase,
		apiKey: resolveApiKey(inf.remoteApiKeyId, inf.remoteApiKey),
		modelId: inf.remoteModelId || 'default',
		contextSize: globalContextSize(settings),
		vision: globalVision(settings),
		qwenTuning: family !== null,
		samplingFamily: family,
		discoveredSampling: toolchest ? (inf.remoteSampling ?? null) : null,
		reasoningMode,
		reasoningSupported,
		reasoningEffort,
		allowParallel: inf.allowParallelInference,
		// Only a toolchest probe reports a slot count; everything else stays
		// unknown, which keeps today's unbounded behaviour for hosted APIs.
		parallelSlots: toolchest ? inf.remoteParallel : null
	};
}

/**
 * How an override drives reasoning: what its server's probe reported, falling
 * back to the model-id guess when it was never probed.
 *
 * `supported` without a drivable mode is a real state, not a contradiction —
 * a server can report a reasoning mechanism (say `reasoning_effort`) that this
 * app cannot set through chat_template_kwargs. Sending `enable_thinking` at
 * such a server would be a guess that silently does nothing, which is exactly
 * how a whole overnight run ended up reasoning with no way to stop it.
 */
function overrideReasoning(
	caps: RemoteReasoningCaps | null,
	qwenKwargs: boolean
): { reasoningMode: ReasoningMode; reasoningSupported: boolean } {
	if (!caps) {
		return {
			reasoningMode: qwenKwargs
				? { kind: 'template-kwarg', kwarg: 'enable_thinking' }
				: { kind: 'none' },
			reasoningSupported: qwenKwargs
		};
	}
	const drivable = caps.supported && caps.toggle === 'chat_template_kwargs' && caps.kwarg;
	return {
		reasoningMode: drivable ? { kind: 'template-kwarg', kwarg: caps.kwarg! } : { kind: 'none' },
		reasoningSupported: caps.supported
	};
}

function resolveOverrideDescriptor(
	settings: AppSettings,
	override: BackendOverride
): BackendDescriptor {
	const base = normalizeBaseUrl(override.baseUrl);
	const openrouter = isOpenRouterUrl(base);
	const traits = modelTraitsFromId(override.modelId);
	const family = traits?.family ?? null;
	// An override that carries no probe data falls back to the model id alone:
	// a Qwen override keeps the tuned profile + enable_thinking (mirroring the
	// remote-Qwen case), anything else gets server defaults.
	const qwenKwargs = !openrouter && family !== null;

	// OpenRouter is excluded from discovered reasoning: its reasoning is driven
	// by the `reasoning.effort` request param, never chat_template_kwargs, so a
	// discovered kwarg there would be sent to a server that ignores it.
	const { reasoningMode, reasoningSupported } = overrideReasoning(
		openrouter ? null : (override.discovered?.reasoning ?? null),
		qwenKwargs
	);

	// A per-job override has no OpenRouter catalog to consult, so an OpenRouter
	// override gets no effort vocabulary — the model's own default applies,
	// exactly as it did before this control existed. Everything else resolves
	// from its persisted probe caps, then its model id.
	const reasoningEffort = openrouter
		? null
		: effortFromCaps(override.discovered?.reasoning ?? null, traits);

	return {
		kind: openrouter ? 'openrouter' : 'remote',
		baseUrl: base,
		apiKey: resolveApiKey(override.apiKeyId, override.apiKey),
		modelId: override.modelId?.trim() || 'default',
		contextSize:
			typeof override.contextSize === 'number' && override.contextSize > 0
				? override.contextSize
				: globalContextSize(settings),
		vision: override.visionSupported ?? globalVision(settings),
		qwenTuning: family !== null,
		samplingFamily: family,
		discoveredSampling: override.discovered?.sampling ?? null,
		reasoningMode,
		reasoningSupported,
		reasoningEffort,
		allowParallel: settings.inferenceBackend.allowParallelInference,
		// A per-job override carries no probe data about slot counts.
		parallelSlots: null
	};
}
