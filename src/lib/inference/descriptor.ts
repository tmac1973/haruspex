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
import { PORTS, baseUrl } from '$lib/ports';
import {
	getActiveLocalModelFilename,
	getApiKeyValue,
	getSettings,
	type AppSettings,
	type InferenceBackendConfig,
	type QwenSamplingFamily,
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
	 * probe). Overrides the built-in profiles when present; null everywhere
	 * else — including per-job overrides, which have no probe data.
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
	/** Whether the inference queue may admit parallel turns on this backend's lane. */
	allowParallel: boolean;
}

/**
 * Map a model identity (local GGUF filename or remote model ID) to a tuned
 * sampling-profile family. Returns null when the model isn't from a
 * recognized lineup. This is the ONLY model-name sniffing in the codebase;
 * it feeds the resolver and nothing else.
 */
function modelFamilyFromId(id: string | null | undefined): QwenSamplingFamily | null {
	if (!id) return null;
	const lower = id.toLowerCase();
	// The dense 27B is the one model whose published thinking/general
	// presence_penalty differs (0.0 vs 1.5); give it its own profile.
	if (lower.includes('qwen3.6-27b') || lower.includes('qwen-3.6-27b')) return 'qwen3.6-27b';
	// Everything else in the lineup (3.5 4B/9B, 3.6 35B-A3B) shares one profile.
	if (
		lower.includes('qwen3.5') ||
		lower.includes('qwen-3.5') ||
		lower.includes('qwen3.6') ||
		lower.includes('qwen-3.6')
	) {
		return 'qwen3.5';
	}
	return null;
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
 *   override's model id alone — never inherited from the global backend, so
 *   a job pointed at server X can't pick up server Y's tuning. Context size
 *   and vision fall back to the global values when the override doesn't
 *   carry its own (matching the pre-descriptor job runner).
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
	const family = modelFamilyFromId(getActiveLocalModelFilename() || null) ?? LOCAL_DEFAULT_FAMILY;
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
		allowParallel: false
	};
}

function resolveRemoteDescriptor(
	settings: AppSettings,
	inf: InferenceBackendConfig,
	remoteBase: string
): BackendDescriptor {
	const openrouter = inf.remoteBackendKind === 'openrouter' || isOpenRouterUrl(remoteBase);
	const family = modelFamilyFromId(inf.remoteModelId);
	// Discovered capabilities are trusted only from a llama-toolchest probe;
	// every other backend kind keeps the built-in behavior.
	const toolchest = inf.remoteBackendKind === 'llama-toolchest';

	let reasoningMode: ReasoningMode = { kind: 'none' };
	let reasoningSupported = false;
	if (openrouter) {
		// OpenRouter reasoning is driven by the `reasoning.effort` request
		// param, never llama.cpp chat_template_kwargs.
		const model = inf.openrouterCatalog?.find((m) => m.id === inf.remoteModelId) ?? null;
		if (model?.reasoning) {
			reasoningSupported = true;
			reasoningMode = {
				kind: 'openrouter-effort',
				effort: inf.openrouterReasoningEffort ?? model.reasoning.default_effort,
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
	} else if (family !== null) {
		// A recognized remote Qwen wants the same enable_thinking kwarg as the
		// managed local lineup; an unrecognized remote model gets nothing.
		reasoningSupported = true;
		reasoningMode = { kind: 'template-kwarg', kwarg: 'enable_thinking' };
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
		allowParallel: inf.allowParallelInference
	};
}

function resolveOverrideDescriptor(
	settings: AppSettings,
	override: BackendOverride
): BackendDescriptor {
	const base = normalizeBaseUrl(override.baseUrl);
	const openrouter = isOpenRouterUrl(base);
	const family = modelFamilyFromId(override.modelId);
	// Overrides have no probe/catalog metadata, so quirks come from the model
	// id alone; a Qwen override keeps the tuned profile + enable_thinking
	// (mirroring the remote-Qwen case), anything else gets server defaults.
	const qwenKwargs = !openrouter && family !== null;
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
		discoveredSampling: null,
		reasoningMode: qwenKwargs
			? { kind: 'template-kwarg', kwarg: 'enable_thinking' }
			: { kind: 'none' },
		reasoningSupported: qwenKwargs,
		allowParallel: settings.inferenceBackend.allowParallelInference
	};
}
