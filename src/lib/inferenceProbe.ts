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
import type {
	InferenceBackendKind,
	RemoteReasoningCaps,
	RemoteSamplingCaps
} from '$lib/stores/settings';

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
