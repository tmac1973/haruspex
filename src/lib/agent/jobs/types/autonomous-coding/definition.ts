import { invoke } from '@tauri-apps/api/core';
import type { JobTypeDefinition, PlannedStep } from '../types';
import { runAutonomousCodingPipeline } from './pipeline';
import {
	DEFAULT_MAX_TURNS,
	MAX_MAX_TURNS,
	MIN_MAX_TURNS,
	parseAutonomousCodingConfig
} from './config';
import Editor from './Editor.svelte';

/** The editor's working state (concrete values; '' = unset). */
export interface AutonomousCodingEditorState {
	plan_dir: string;
	max_attempts: number;
	signing_fallback: 'unsigned' | 'skip';
	create_branch: boolean;
	use_git: boolean;
	web_research: boolean;
	max_turns: number;
	mute_preflight: boolean;
	/** Carried untouched: a chain sets these, and the editor has no fields for them. */
	open_findings: string[];
	asset_spec_path: string | null;
	missing_assets: string[];
}

/**
 * Display stages, in step-index order — the pipeline's stage constants
 * (PREFLIGHT = 0, …) must match. The Decompose stage replaces the run's
 * step list with the real TODO items once they exist (Phase 06).
 */
const CODING_STAGES: ReadonlyArray<{ title: string; description: string }> = [
	{
		title: 'Preflight',
		description:
			'Reading the plan and interviewing you about every open decision — the last human checkpoint before the run goes unattended.'
	},
	{
		title: 'Decompose',
		description:
			"Reading the plan's own phases and steps into the checklist (TODO-coding.md) — parsed directly when the plan follows the guided-planning template, decomposed by the model otherwise."
	},
	{
		title: 'Coding loop',
		description:
			'Implementing the checklist — each step checked and committed, each phase deep-verified at its boundary — until every step is done or blocked.'
	},
	{
		title: 'Finalize',
		description: 'Writing REPORT-coding.md: what was built, what is blocked and why, next steps.'
	},
	{
		title: 'Document',
		description:
			'Writing README.md for the project itself — what it does, how to build and run it, and what the run did not finish.'
	}
];

function planCodingSteps(): PlannedStep[] {
	return CODING_STAGES.map((stage) => ({
		authored: stage.title,
		deepResearch: false,
		description: stage.description
	}));
}

export const autonomousCodingJobType: JobTypeDefinition = {
	id: 'autonomous_coding',
	label: 'Autonomous coding',
	description:
		'Takes a folder of plan files, resolves open decisions with you up front, then codes the project unattended — one atomic step at a time, verified and committed, until the plan is done.',
	// Runs are driven by the plan dir + preflight interview, not authored steps.
	hasPlannedSteps: false,
	// The run opens with the preflight interview — a scheduled fire would park
	// on the first question with nobody there to answer it.
	supportsSchedule: false,
	// Full-shell job type: only offered where the shell plumbing works. The
	// single choke point is shell_platform_supported() — no other platform
	// checks belong in this module (see the Code-mode × Windows notes).
	available: async () => {
		try {
			return await invoke<boolean>('shell_platform_supported');
		} catch {
			return false;
		}
	},
	workingDirPlaceholder: 'Absolute path to the project to build in',
	Editor,
	configDefaults: (): AutonomousCodingEditorState & Record<string, unknown> => ({
		plan_dir: '',
		max_attempts: 3,
		signing_fallback: 'unsigned',
		create_branch: true,
		web_research: true,
		use_git: true,
		max_turns: DEFAULT_MAX_TURNS,
		mute_preflight: false,
		open_findings: [],
		asset_spec_path: null,
		missing_assets: []
	}),
	configFromJob: (typeConfig) => {
		const c = parseAutonomousCodingConfig(typeConfig);
		return {
			plan_dir: c.plan_dir ?? '',
			max_attempts: c.max_attempts ?? 3,
			signing_fallback: c.signing_fallback ?? 'unsigned',
			create_branch: c.create_branch ?? true,
			web_research: c.web_research ?? true,
			use_git: c.use_git ?? true,
			max_turns: c.max_turns ?? DEFAULT_MAX_TURNS,
			mute_preflight: c.mute_preflight ?? false,
			open_findings: c.open_findings,
			asset_spec_path: c.asset_spec_path,
			missing_assets: c.missing_assets
		};
	},
	configToJson: (config) => {
		const s = config as unknown as AutonomousCodingEditorState;
		return JSON.stringify({
			plan_dir: s.plan_dir.trim() || undefined,
			max_attempts: s.max_attempts,
			signing_fallback: s.signing_fallback,
			create_branch: s.create_branch,
			web_research: s.web_research,
			use_git: s.use_git,
			max_turns: s.max_turns,
			mute_preflight: s.mute_preflight,
			// Saving from the editor used to drop these, so a chain's coding job
			// edited by hand lost the plan review's findings and its art.
			open_findings: s.open_findings?.length ? s.open_findings : undefined,
			asset_spec_path: s.asset_spec_path ?? undefined,
			missing_assets: s.missing_assets?.length ? s.missing_assets : undefined
		});
	},
	validate: ({ workingDir, config }) => {
		const s = config as unknown as AutonomousCodingEditorState;
		if (!workingDir.trim())
			return 'Autonomous coding needs a working directory — the project to build in.';
		if (!s.plan_dir.trim()) return 'A plan directory is required — the folder of plan files.';
		if (!Number.isFinite(s.max_attempts) || s.max_attempts < 1 || s.max_attempts > 10)
			return 'Max attempts per step must be between 1 and 10.';
		if (!Number.isFinite(s.max_turns) || s.max_turns < MIN_MAX_TURNS || s.max_turns > MAX_MAX_TURNS)
			return `Max model steps per turn must be between ${MIN_MAX_TURNS} and ${MAX_MAX_TURNS}.`;
		return null;
	},
	planSteps: planCodingSteps,
	runPipeline: runAutonomousCodingPipeline
};
