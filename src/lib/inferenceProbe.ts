/**
 * Shared types + helpers for the `probe_inference_server` IPC command, used by
 * both the Settings remote-backend form (InferenceBackendForm) and the per-job
 * model override (JobEditor). Centralizing the response shape and the
 * default-model precedence keeps the two probe flows from disagreeing.
 *
 * Note: the two callers intentionally differ in how they *adopt* a probe
 * result (Settings uses the server-level default context; JobEditor prefers the
 * picked model's own context and falls back to the server default). That policy
 * stays in each component — only the shared shape and the model-pick precedence
 * live here.
 */
import { invoke } from '@tauri-apps/api/core';
import { getApiKeyValue } from '#lib/stores/settings.ts';
import { apiKeysReady } from '#lib/stores/apiKeySecrets.ts';
import type {
	InferenceBackendKind,
	RemoteReasoningCaps,
	RemoteSamplingCaps
} from '#lib/stores/settings.ts';

/** A single model entry as normalized by `probe_inference_server`. */
export interface NormalizedModel {
	id: string;
	display_name: string;
	context_size: number | null;
	vision_supported: boolean | null;
	loaded: boolean | null;
	// llama-toolchest only — null for every other backend.
	parallel: number | null;
	reasoning: RemoteReasoningCaps | null;
	sampling: RemoteSamplingCaps | null;
}

/** The `probe_inference_server` response. */
export interface ProbeResult {
	base_url: string;
	kind: InferenceBackendKind;
	models: NormalizedModel[];
	default_context_size: number | null;
	notes: string;
	/** The engine behind a toolchest (`'vllm'`, `'llama.cpp'`), when its status names one. */
	engine: string | null;
}

/** How an engine name a toolchest reports is written for people. */
function engineName(engine: string): string {
	const known: Record<string, string> = {
		vllm: 'vLLM',
		'llama.cpp': 'llama.cpp',
		sglang: 'SGLang'
	};
	return known[engine.toLowerCase()] ?? engine;
}

/**
 * A backend kind as Settings shows it. `llama-toolchest` is the management
 * API that llama-toolchest and vllm-toolchest share, so it reads as
 * "toolchest", with the engine when the server names it.
 */
export function backendLabel(kind: InferenceBackendKind, engine: string | null = null): string {
	switch (kind) {
		case 'llama-toolchest':
			return engine ? `toolchest (${engineName(engine)})` : 'toolchest';
		case 'llama-server':
			return 'llama-server';
		case 'openai-compat':
			return 'OpenAI-compatible';
		case 'ollama':
			return 'Ollama';
		case 'openrouter':
			return 'OpenRouter';
		default:
			return 'Unknown';
	}
}

/**
 * Default model selection after a probe: keep the current selection if the
 * server still lists it, otherwise the first loaded model, otherwise the first
 * model overall. Returns `undefined` only when the server reported no models.
 */
export function pickProbedModel<M extends { id: string; loaded: boolean | null }>(
	models: M[],
	currentId: string | null | undefined
): M | undefined {
	return (
		models.find((m) => m.id === currentId) ?? models.find((m) => m.loaded === true) ?? models[0]
	);
}

/**
 * Run the `probe_inference_server` IPC with key material resolved the same
 * way everywhere: a key-store reference wins over the inline legacy key;
 * blank means no Authorization header. Shared by the Settings backend form
 * and the per-job model override.
 */
export async function probeInferenceServer(
	baseUrl: string,
	apiKeyId: string | null,
	inlineKey = ''
): Promise<ProbeResult> {
	await apiKeysReady();
	const resolvedKey = getApiKeyValue(apiKeyId) ?? inlineKey;
	return invoke<ProbeResult>('probe_inference_server', {
		baseUrl,
		apiKey: resolvedKey || null
	});
}

/**
 * Context/vision capabilities a probed model reports (null = the model
 * didn't say, leave the caller's manual value alone).
 */
export function probedModelCaps(m: NormalizedModel | undefined): {
	contextSize: number | null;
	vision: boolean | null;
} {
	return {
		contextSize: typeof m?.context_size === 'number' && m.context_size > 0 ? m.context_size : null,
		vision: m?.vision_supported ?? null
	};
}
