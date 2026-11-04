import type { JobTypeDefinition, PlannedStep } from '#lib/agent/jobs/types/types.ts';
import type { ChainModel, ModelColumns } from '#lib/agent/jobs/chainModel.ts';
import { runModelGenerationPipeline } from '#lib/agent/jobs/types/model-generation/pipeline.ts';
import {
	parseModelGenerationConfig,
	DEFAULT_ROUNDS,
	DEFAULT_STAGE_TURNS,
	MAX_ROUNDS,
	MAX_STAGE_TURNS,
	MIN_ROUNDS,
	MIN_STAGE_TURNS,
	type ModelRunMode
} from '#lib/agent/jobs/types/model-generation/config.ts';
import {
	modelColumnsFromForm,
	modelFormFromColumns,
	stageModelProblem,
	type JobModelForm
} from '#lib/agent/jobs/jobModelForm.ts';
import Editor from '#lib/agent/jobs/types/model-generation/Editor.svelte';

/** The editor's working state (concrete values; '' = unset). */
export interface ModelGenerationEditorState {
	/** '' = the default path, assets/haruspex-models.json. */
	spec_path: string;
	description: string;
	run_mode: ModelRunMode;
	/** A stage's model; null = same as this job. */
	chain_create_model: JobModelForm | null;
	chain_animate_model: JobModelForm | null;
	allow_textures: boolean;
	noise_colour: boolean;
	create_turns: number;
	animate_turns: number;
	rounds: number;
	use_git: boolean;
	/** Carried untouched: a chain sets these. Only hand_off has a field. */
	hand_off: boolean;
	coding_run: Record<string, unknown> | null;
	chain_base_name: string | null;
	chain_coding_model: ModelColumns | null;
}

/**
 * Display stages, in step-index order: the pipeline's stage constants
 * (SPEC = 0, …) must match.
 */
const MODEL_STAGES: ReadonlyArray<{ title: string; description: string }> = [
	{ title: 'Spec', description: 'Read or write models.json' },
	{ title: 'Create', description: 'Build every model' },
	{ title: 'Animate', description: 'Animate the models with clips' },
	{ title: 'Report', description: 'Write the report' },
	{ title: 'Hand off', description: 'Start the coding run, when chained' }
];

function planModelSteps(): PlannedStep[] {
	return MODEL_STAGES.map((stage) => ({
		authored: stage.title,
		deepResearch: false,
		description: stage.description
	}));
}

/** A stage's form as stored, or undefined for "same as this job". */
function stageModelJson(form: JobModelForm | null): ChainModel | undefined {
	return form ? modelColumnsFromForm(form) : undefined;
}

function inRange(n: number, lo: number, hi: number): boolean {
	return Number.isInteger(n) && n >= lo && n <= hi;
}

/** The first limit out of range, or null. */
function limitsProblem(s: ModelGenerationEditorState): string | null {
	if (!inRange(s.create_turns, MIN_STAGE_TURNS, MAX_STAGE_TURNS)) {
		return `Steps per creation turn must be between ${MIN_STAGE_TURNS} and ${MAX_STAGE_TURNS}.`;
	}
	if (!inRange(s.animate_turns, MIN_STAGE_TURNS, MAX_STAGE_TURNS)) {
		return `Steps per animation turn must be between ${MIN_STAGE_TURNS} and ${MAX_STAGE_TURNS}.`;
	}
	if (!inRange(s.rounds, MIN_ROUNDS, MAX_ROUNDS)) {
		return `Turns per model must be between ${MIN_ROUNDS} and ${MAX_ROUNDS}.`;
	}
	return null;
}

export const modelGenerationJobType: JobTypeDefinition = {
	id: 'model_generation',
	label: '3D models',
	description: 'Build 3D models from a spec with check_3d, then animate them on a second model.',
	badgeLabel: '3D',
	hasPlannedSteps: false,
	// Attended runs stop for a review, and a scheduled one would park on it
	// with nobody there.
	supportsSchedule: false,
	workingDirPlaceholder: 'The project folder',
	Editor,
	configDefaults: (): ModelGenerationEditorState & Record<string, unknown> => ({
		spec_path: '',
		description: '',
		run_mode: 'attended',
		chain_create_model: null,
		chain_animate_model: null,
		allow_textures: false,
		noise_colour: false,
		create_turns: DEFAULT_STAGE_TURNS,
		animate_turns: DEFAULT_STAGE_TURNS,
		rounds: DEFAULT_ROUNDS,
		use_git: true,
		hand_off: true,
		coding_run: null,
		chain_base_name: null,
		chain_coding_model: null
	}),
	configFromJob: (typeConfig) => {
		const c = parseModelGenerationConfig(typeConfig);
		return {
			spec_path: c.spec_path ?? '',
			description: c.description ?? '',
			run_mode: c.run_mode,
			chain_create_model: c.create_model ? modelFormFromColumns(c.create_model) : null,
			chain_animate_model: c.animate_model ? modelFormFromColumns(c.animate_model) : null,
			allow_textures: c.allow_textures,
			noise_colour: c.noise_colour,
			create_turns: c.create_turns,
			animate_turns: c.animate_turns,
			rounds: c.rounds,
			use_git: c.use_git,
			hand_off: c.hand_off ?? true,
			coding_run: c.coding_run,
			chain_base_name: c.chain_base_name,
			chain_coding_model: c.chain_coding_model
		};
	},
	configToJson: (config) => {
		const s = config as unknown as ModelGenerationEditorState;
		return JSON.stringify({
			spec_path: s.spec_path.trim() || undefined,
			description: s.description.trim() || undefined,
			run_mode: s.run_mode,
			create_model: stageModelJson(s.chain_create_model),
			animate_model: stageModelJson(s.chain_animate_model),
			allow_textures: s.allow_textures,
			noise_colour: s.noise_colour,
			create_turns: s.create_turns,
			animate_turns: s.animate_turns,
			rounds: s.rounds,
			use_git: s.use_git,
			// Only meaningful, and only written, for a job a chain made.
			...(s.coding_run
				? {
						hand_off: s.hand_off,
						coding_run: s.coding_run,
						chain_base_name: s.chain_base_name ?? undefined,
						chain_coding_model: s.chain_coding_model ?? undefined
					}
				: {})
		});
	},
	validate: ({ workingDir, config }) => {
		const s = config as unknown as ModelGenerationEditorState;
		if (!workingDir.trim()) {
			return '3D models needs a working directory — the project to write models into.';
		}
		// Whether the spec exists is the run's question; here, only that the run
		// has something to go on.
		if (!s.spec_path.trim() && !s.description.trim()) {
			return 'Give a spec path or describe what to make.';
		}
		return (
			stageModelProblem('creation model', s.chain_create_model) ??
			stageModelProblem('animation model', s.chain_animate_model) ??
			limitsProblem(s)
		);
	},
	missingRequired: ({ config }) => {
		const s = config as unknown as ModelGenerationEditorState;
		return [
			...(s.spec_path.trim() || s.description.trim() ? [] : ['Description or spec']),
			...(stageModelProblem('creation model', s.chain_create_model) ? ['Creation model'] : []),
			...(stageModelProblem('animation model', s.chain_animate_model) ? ['Animation model'] : [])
		];
	},
	planSteps: planModelSteps,
	runPipeline: runModelGenerationPipeline
};
