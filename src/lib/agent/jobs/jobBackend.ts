import type { BackendOverride } from '#lib/api.ts';
import type { ModelOverrideConfig } from '#lib/stores/jobs.svelte.ts';
import { parseModelAdvanced } from '#lib/agent/jobs/modelAdvanced.ts';
import { modelColumnsOf, type ModelColumns } from '#lib/agent/jobs/chainModel.ts';

/**
 * The remote backend a job should run against, or undefined to use the global
 * Settings backend. Active iff the job has a non-blank remote base URL — the
 * override is remote-only by design (local jobs follow Settings). Applies to
 * every turn the job runs, regardless of job type.
 */
export function jobBackendOverride(job: ModelOverrideConfig): BackendOverride | undefined {
	return backendOverrideFor(modelColumnsOf(job));
}

/**
 * The remote backend a set of model columns names, or undefined for the
 * Settings backend. Split out of `jobBackendOverride` so a pipeline can run
 * one turn on a model other than the job's (a 3D run's creation and
 * animation models).
 */
export function backendOverrideFor(job: ModelColumns): BackendOverride | undefined {
	const url = job.model_remote_base_url?.trim();
	if (!url) return undefined;
	return {
		baseUrl: url,
		apiKey: job.model_remote_api_key?.trim() || undefined,
		apiKeyId: job.model_remote_api_key_id ?? undefined,
		modelId: job.model_remote_model_id?.trim() || undefined,
		contextSize: job.model_remote_context_size ?? undefined,
		visionSupported: job.model_remote_vision_supported ?? undefined,
		// What the editor's last probe of this server reported. Without it the
		// descriptor can only guess the model's reasoning mechanism from its
		// id, and guesses "none" for anything off the built-in Qwen list.
		// Omitted rather than null when never probed — absent is what the
		// descriptor reads as "fall back to the id guess".
		discovered: parseModelAdvanced(job.model_advanced).discovered ?? undefined
	};
}
