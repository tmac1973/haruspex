/**
 * Which model each stage of a chain (guided planning → assets → coding) runs
 * on.
 *
 * A chained job is born and started in the same breath, with no window in
 * which to edit it, so its model is decided here. By default every stage
 * inherits the planning job's model. A stage override lets a chain plan with a
 * strong model and code with a fast one.
 */

/** The job columns that choose a job's model, as `createJob` takes them. */
export interface ModelColumns {
	model_remote_base_url: string | null;
	model_remote_api_key: string | null;
	model_remote_api_key_id: string | null;
	model_remote_model_id: string | null;
	model_remote_context_size: number | null;
	model_remote_vision_supported: boolean | null;
	model_advanced: string | null;
}

/**
 * A stage's model override: the same columns, stored in the planning job's
 * type_config. Null means "same as the job that creates the stage".
 */
export type ChainModel = ModelColumns;

/** The model columns of `job`, and nothing else. */
export function modelColumnsOf(job: ModelColumns): ModelColumns {
	return {
		model_remote_base_url: job.model_remote_base_url,
		model_remote_api_key: job.model_remote_api_key,
		model_remote_api_key_id: job.model_remote_api_key_id,
		model_remote_model_id: job.model_remote_model_id,
		model_remote_context_size: job.model_remote_context_size,
		model_remote_vision_supported: job.model_remote_vision_supported,
		model_advanced: job.model_advanced
	};
}

/**
 * The model a stage runs on: the override's columns when there is one, the
 * creating job's otherwise. Whole, never merged field by field: a model id
 * from one server paired with another server's URL is a run that fails at its
 * first call. A key held by id is copied as the id; it is resolved at request
 * time, never written out here.
 */
export function stageModelColumns(job: ModelColumns, override: ChainModel | null): ModelColumns {
	return modelColumnsOf(override ?? job);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * A stored override, read defensively. Anything malformed is null ("same as
 * this job"), never a half-filled override: a stage silently pointed at a
 * server with no model is worse than one that inherits.
 *
 * An override whose URL is present and null is the Settings model: whatever
 * Settings → Inference has active, the local model included. That differs
 * from "same as this job" whenever the planning job has its own server.
 */
export function parseChainModel(raw: unknown): ChainModel | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const baseUrl = str(r.model_remote_base_url);
	const modelId = str(r.model_remote_model_id);
	if ('model_remote_base_url' in r && r.model_remote_base_url === null && !modelId) {
		return {
			model_remote_base_url: null,
			model_remote_api_key: null,
			model_remote_api_key_id: null,
			model_remote_model_id: null,
			model_remote_context_size: null,
			model_remote_vision_supported: null,
			model_advanced: str(r.model_advanced)
		};
	}
	if (!baseUrl || !modelId) return null;
	const ctx = r.model_remote_context_size;
	const vision = r.model_remote_vision_supported;
	return {
		model_remote_base_url: baseUrl,
		model_remote_api_key: str(r.model_remote_api_key),
		model_remote_api_key_id: str(r.model_remote_api_key_id),
		model_remote_model_id: modelId,
		model_remote_context_size:
			typeof ctx === 'number' && Number.isFinite(ctx) && ctx > 0 ? ctx : null,
		model_remote_vision_supported: typeof vision === 'boolean' ? vision : null,
		model_advanced: str(r.model_advanced)
	};
}

/**
 * Resolved model columns handed from one stage to the next, read defensively.
 * Unlike an override, all-null is valid here: it means "the Settings model",
 * which is what a planning job on Settings hands on. Null only when absent or
 * not an object.
 */
export function parseModelColumns(raw: unknown): ModelColumns | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const ctx = r.model_remote_context_size;
	const vision = r.model_remote_vision_supported;
	return {
		model_remote_base_url: str(r.model_remote_base_url),
		model_remote_api_key: str(r.model_remote_api_key),
		model_remote_api_key_id: str(r.model_remote_api_key_id),
		model_remote_model_id: str(r.model_remote_model_id),
		model_remote_context_size:
			typeof ctx === 'number' && Number.isFinite(ctx) && ctx > 0 ? ctx : null,
		model_remote_vision_supported: typeof vision === 'boolean' ? vision : null,
		model_advanced: str(r.model_advanced)
	};
}

/** How a stage's model reads in a handoff message. */
export function describeStageModel(cols: ModelColumns): string {
	return cols.model_remote_model_id ?? 'the Settings model';
}
