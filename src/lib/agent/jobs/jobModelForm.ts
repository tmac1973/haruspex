/**
 * The job model editor's form state, and its conversion to and from the job's
 * model columns.
 *
 * Plain JSON on purpose: the same form is used by JobEditor for a job's own
 * model and inside the guided-planning editor's type config for each chained
 * stage, and type config is snapshotted and serialised.
 */
import {
	defaultModelAdvanced,
	parseModelAdvanced,
	serializeModelAdvanced,
	type DiscoveredCaps,
	type JobModelAdvanced,
	type ReasoningMode,
	type SamplingSource
} from './modelAdvanced';
import type { ModelColumns } from './chainModel';

/** Where a job's model calls go. 'settings' follows Settings → Inference. */
export type ModelSource = 'settings' | 'remote' | 'openrouter';

export interface JobModelForm {
	source: ModelSource;
	baseUrl: string;
	apiKey: string;
	apiKeyId: string | null;
	modelId: string;
	/** '' = use the Settings size. */
	contextSize: number | '';
	/** 'auto' inherits the global capability. */
	vision: 'auto' | 'yes' | 'no';
	// Advanced model behaviour, flattened for the form. These apply even on
	// the Settings backend: a job still wants its own reasoning choice.
	reasoning: ReasoningMode;
	/** null = inherit the global effort. */
	effort: string | null;
	samplingSource: SamplingSource;
	/** Custom sampling. '' = omit the parameter from the request. */
	temperature: number | '';
	topP: number | '';
	topK: number | '';
	minP: number | '';
	presencePenalty: number | '';
	discovered: DiscoveredCaps | null;
	/**
	 * Whether the sampling source was picked by hand. Until it is, a probe that
	 * finds server-published recommendations may switch it to 'server'.
	 */
	sourceTouched: boolean;
}

export function isOpenRouterUrl(url: string): boolean {
	try {
		return new URL(url).hostname === 'openrouter.ai';
	} catch {
		return false;
	}
}

function withAdvanced(form: JobModelForm, adv: JobModelAdvanced): JobModelForm {
	const p = adv.sampling.params;
	return {
		...form,
		reasoning: adv.reasoning.mode,
		effort: adv.reasoning.effort,
		samplingSource: adv.sampling.source,
		discovered: adv.discovered,
		temperature: p?.temperature ?? '',
		topP: p?.top_p ?? '',
		topK: p?.top_k ?? '',
		minP: p?.min_p ?? '',
		presencePenalty: p?.presence_penalty ?? ''
	};
}

/** A new job's form: the Settings model, default behaviour. */
export function emptyModelForm(source: ModelSource = 'settings'): JobModelForm {
	return withAdvanced(
		{
			source,
			baseUrl: '',
			apiKey: '',
			apiKeyId: null,
			modelId: '',
			contextSize: '',
			vision: 'auto',
			reasoning: 'inherit',
			effort: null,
			samplingSource: 'profile',
			temperature: '',
			topP: '',
			topK: '',
			minP: '',
			presencePenalty: '',
			discovered: null,
			sourceTouched: false
		},
		defaultModelAdvanced()
	);
}

/** A stored job's (or stage override's) columns, as the form. */
export function modelFormFromColumns(cols: ModelColumns): JobModelForm {
	const baseUrl = cols.model_remote_base_url ?? '';
	const form = withAdvanced(
		{
			...emptyModelForm(),
			// No base URL → the job follows Settings; OpenRouter is told by URL.
			source: !baseUrl ? 'settings' : isOpenRouterUrl(baseUrl) ? 'openrouter' : 'remote',
			baseUrl,
			apiKey: cols.model_remote_api_key ?? '',
			apiKeyId: cols.model_remote_api_key_id ?? null,
			modelId: cols.model_remote_model_id ?? '',
			contextSize: cols.model_remote_context_size ?? '',
			vision:
				cols.model_remote_vision_supported == null
					? 'auto'
					: cols.model_remote_vision_supported
						? 'yes'
						: 'no'
		},
		parseModelAdvanced(cols.model_advanced)
	);
	// A STORED config is the owner's decision and a later probe must not move
	// it. A job saved before the column existed stored nothing, so its
	// 'profile' is the absence of a choice: leave it adoptable.
	form.sourceTouched = cols.model_advanced !== null;
	return form;
}

/** The form's advanced fields as the shape `model_advanced` stores. */
export function modelAdvancedOf(form: JobModelForm): JobModelAdvanced {
	const n = (v: number | '') => (v === '' ? undefined : v);
	return {
		reasoning: { mode: form.reasoning, effort: form.effort },
		sampling: {
			source: form.samplingSource,
			params: {
				temperature: n(form.temperature),
				top_p: n(form.topP),
				top_k: n(form.topK),
				min_p: n(form.minP),
				presence_penalty: n(form.presencePenalty)
			}
		},
		discovered: form.discovered
	};
}

/**
 * The form as job columns. The remote columns are written only when a
 * specific source is chosen AND a URL is set; otherwise the job follows
 * Settings (all null). `model_advanced` is written either way.
 */
export function modelColumnsFromForm(form: JobModelForm): ModelColumns {
	const url = form.source !== 'settings' ? form.baseUrl.trim() : '';
	return {
		model_remote_base_url: url || null,
		model_remote_api_key: url && form.apiKey.trim() ? form.apiKey.trim() : null,
		model_remote_api_key_id: url && form.apiKeyId ? form.apiKeyId : null,
		model_remote_model_id: url && form.modelId.trim() ? form.modelId.trim() : null,
		model_remote_context_size:
			url && typeof form.contextSize === 'number' ? form.contextSize : null,
		model_remote_vision_supported: url && form.vision !== 'auto' ? form.vision === 'yes' : null,
		model_advanced: serializeModelAdvanced(modelAdvancedOf(form))
	};
}

/** One line for a folded section. */
export function modelFormSummary(form: JobModelForm): string {
	return form.source === 'settings'
		? 'Settings default'
		: `${form.source === 'openrouter' ? 'OpenRouter' : 'Remote'} · ${form.modelId.trim() || 'no model picked'}`;
}
