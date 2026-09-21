import type { JobTypeDefinition, PlannedStep } from '../types';
import { runGuidedPlanningPipeline } from './pipeline';
import { type GuidedPlanningRunMode, parseGuidedPlanningConfig } from './config';
import { DEFAULT_MAX_TURNS } from '../autonomous-coding/config';
import Editor from './Editor.svelte';

/** The guided-planning editor's working state (concrete strings, '' = unset). */
export interface GuidedPlanningEditorState {
	initial_description: string;
	plan_output_dir: string;
	skip_verification: boolean;
	web_research: boolean;
	use_git: boolean;
	run_mode: GuidedPlanningRunMode;
	// Concrete strings/numbers in the editor ('' and 0 = unset), converted back
	// to nulls by configToJson.
	coding_max_attempts: number;
	coding_context_mode: '' | 'step' | 'phase';
	coding_max_turns: number;
}

/**
 * Display stages a guided_planning run advances through, in step-index order.
 * The pipeline's stage index constants (OVERVIEW = 0, …) must match this
 * order; the descriptions give the run view context for each stage's tool
 * calls and thinking.
 */
const GUIDED_STAGES: ReadonlyArray<{ title: string; description: string }> = [
	{
		title: 'Overview',
		description:
			'Interviewing you about the project, then writing overview.md. Answer “proceed” to any question to move on.'
	},
	{
		title: 'Outline',
		description:
			'Interviewing you about the implementation, then proposing a dependency-ordered phase outline for you to approve.'
	},
	{
		title: 'Planning',
		description: 'Writing the phase files from the approved outline — one focused write per phase.'
	},
	{
		title: 'Verification',
		description:
			'An independent reviewer is reading the plan to check dependency ordering, unresolved (“TBD”) decisions, embedded code and unreachable steps. Can be switched off in the job editor.'
	},
	{
		title: 'Approval',
		description: 'Waiting for you to review the phase files and approve — or request changes.'
	},
	{
		title: 'Handoff',
		description:
			'Starting an autonomous coding run on the finished plan, or recording why it did not — the run mode, or verification findings an unattended run could not survive.'
	}
];

/**
 * The chained coding run's overrides, or undefined when nothing is pinned.
 *
 * Unset fields are omitted rather than stored as null: the coding job's own
 * defaults and its preflight should settle anything the user did not pin, and
 * an object of nulls reads as decisions somebody made.
 */
function codingRunJson(s: GuidedPlanningEditorState): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = {};
	// Stored only when it differs from what the coding job would pick anyway.
	if (s.coding_max_attempts > 0 && s.coding_max_attempts !== 3)
		out.max_attempts = s.coding_max_attempts;
	if (s.coding_context_mode) out.context_mode = s.coding_context_mode;
	if (s.coding_max_turns > 0 && s.coding_max_turns !== DEFAULT_MAX_TURNS)
		out.max_turns = s.coding_max_turns;
	return Object.keys(out).length > 0 ? out : undefined;
}

function planGuidedSteps(): PlannedStep[] {
	return GUIDED_STAGES.map((stage) => ({
		authored: stage.title,
		deepResearch: false,
		description: stage.description
	}));
}

export const guidedPlanningJobType: JobTypeDefinition = {
	id: 'guided_planning',
	label: 'Guided planning',
	description:
		'Asks you multiple-choice questions to define the project, then writes an overview and a dependency-ordered, phased implementation plan as markdown. Planning only — it never writes code.',
	// Runs are driven by the initial description + interactive Q&A, not a step
	// pipeline — a guided job with zero authored steps is the normal case.
	hasPlannedSteps: false,
	// The run opens with an interview — a scheduled fire would park on the
	// first question with nobody there to answer it.
	supportsSchedule: false,
	workingDirPlaceholder: 'Absolute path to the project to plan in',
	Editor,
	configDefaults: () => ({
		initial_description: '',
		plan_output_dir: '',
		skip_verification: false,
		web_research: true,
		use_git: true,
		run_mode: 'attended',
		// The coding job's own default, shown as itself. A 0 here meant "unset"
		// and read on screen as "zero attempts", which is not a thing.
		coding_max_attempts: 3,
		coding_context_mode: '',
		coding_max_turns: DEFAULT_MAX_TURNS
	}),
	configFromJob: (typeConfig) => {
		const c = parseGuidedPlanningConfig(typeConfig);
		return {
			initial_description: c.initial_description ?? '',
			plan_output_dir: c.plan_output_dir ?? '',
			skip_verification: c.skip_verification,
			web_research: c.web_research,
			use_git: c.use_git,
			run_mode: c.run_mode,
			coding_max_attempts: c.coding_run.max_attempts ?? 3,
			coding_context_mode: c.coding_run.context_mode ?? '',
			coding_max_turns: c.coding_run.max_turns ?? DEFAULT_MAX_TURNS
		};
	},
	configToJson: (config) => {
		const s = config as unknown as GuidedPlanningEditorState;
		return JSON.stringify({
			initial_description: s.initial_description.trim() || undefined,
			plan_output_dir: s.plan_output_dir.trim() || undefined,
			skip_verification: s.skip_verification || undefined,
			// Sparse like skip_verification: only the non-default value is stored.
			web_research: s.web_research ? undefined : false,
			use_git: s.use_git ? undefined : false,
			// Sparse: only a non-default mode is stored.
			run_mode: s.run_mode === 'attended' ? undefined : s.run_mode,
			coding_run: codingRunJson(s)
		});
	},
	validate: ({ workingDir, config }) => {
		const s = config as unknown as GuidedPlanningEditorState;
		if (!workingDir.trim())
			return 'Guided planning needs a working directory — the project to plan in.';
		if (!s.initial_description.trim()) return 'Describe what you want to build to start planning.';
		return null;
	},
	planSteps: planGuidedSteps,
	runPipeline: runGuidedPlanningPipeline
};
