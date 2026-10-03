import type { JobTypeDefinition, PlannedStep } from '../types';
import { runAssetGenerationPipeline } from './pipeline';
import {
	parseAssetGenerationConfig,
	DEFAULT_ANCHOR_ATTEMPTS,
	DEFAULT_CONCURRENCY,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_TARGET_SIZE,
	MAX_TARGET_SIZE,
	MIN_TARGET_SIZE,
	type AssetRunMode
} from './config';
import { DEFAULT_SPEC_PATH } from '$lib/assets/spec/paths';
import { resolveImageBackend } from '$lib/image';
import Editor from './Editor.svelte';

/** The editor's working state (concrete values; '' = unset). */
export interface AssetGenerationEditorState {
	spec_path: string;
	description: string;
	run_mode: AssetRunMode;
	target_size: number;
	max_attempts: number;
	anchor_attempts: number;
	concurrency: number;
	vision_judge: boolean;
	use_git: boolean;
}

/**
 * Display stages, in step-index order — the pipeline's stage constants
 * (SPEC = 0, …) must match. Five from the start, including the handoff the
 * chain phase fills in: adding a stage later would move every index after it.
 */
const ASSET_STAGES: ReadonlyArray<{ title: string; description: string }> = [
	{
		title: 'Spec',
		description:
			'Reading the asset spec, or writing one from your description — every asset to make, with its id, kind, prompt and output path.'
	},
	{
		title: 'Style anchor',
		description:
			'Generating the reference sheet every asset is conditioned on, and committing it with the recipe that made it. The only point a run stops for you.'
	},
	{
		title: 'Generate',
		description:
			'Making each asset, normalizing it to the shared palette and pixel grid, and writing it where the spec says.'
	},
	{
		title: 'Report',
		description:
			'Writing REPORT-assets.md: what was made, what was degraded, what could not be made.'
	},
	{
		title: 'Handoff',
		description: 'Starting the coding run, when this job was chained from a plan.'
	}
];

function planAssetSteps(): PlannedStep[] {
	return ASSET_STAGES.map((stage) => ({
		authored: stage.title,
		deepResearch: false,
		description: stage.description
	}));
}

function isPowerOfTwo(n: number): boolean {
	return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export const assetGenerationJobType: JobTypeDefinition = {
	id: 'asset_generation',
	label: 'Asset generation',
	description:
		'Takes a list of images a project needs and makes them — one style anchor, then every asset conditioned on it, normalized to a shared palette and pixel grid.',
	hasPlannedSteps: false,
	// The anchor checkpoint would park a scheduled run on a modal with nobody
	// there, the same reason guided planning refuses one.
	supportsSchedule: false,
	// Availability, not platform: the job is meaningless without somewhere to
	// generate. A run whose backend disappeared since is caught by the pipeline.
	available: async () => resolveImageBackend().kind !== 'none',
	Editor,
	configDefaults: (): AssetGenerationEditorState & Record<string, unknown> => ({
		spec_path: DEFAULT_SPEC_PATH,
		description: '',
		run_mode: 'attended',
		target_size: DEFAULT_TARGET_SIZE,
		max_attempts: DEFAULT_MAX_ATTEMPTS,
		anchor_attempts: DEFAULT_ANCHOR_ATTEMPTS,
		concurrency: DEFAULT_CONCURRENCY,
		vision_judge: true,
		use_git: true
	}),
	configFromJob: (typeConfig) => {
		const c = parseAssetGenerationConfig(typeConfig);
		return {
			spec_path: c.spec_path ?? DEFAULT_SPEC_PATH,
			description: c.description ?? '',
			run_mode: c.run_mode,
			target_size: c.target_size ?? DEFAULT_TARGET_SIZE,
			max_attempts: c.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
			anchor_attempts: c.anchor_attempts ?? DEFAULT_ANCHOR_ATTEMPTS,
			concurrency: c.concurrency ?? DEFAULT_CONCURRENCY,
			vision_judge: c.vision_judge ?? true,
			use_git: c.use_git ?? true
		};
	},
	configToJson: (config) => {
		const s = config as unknown as AssetGenerationEditorState;
		return JSON.stringify({
			spec_path: s.spec_path.trim() || undefined,
			description: s.description.trim() || undefined,
			run_mode: s.run_mode,
			target_size: s.target_size,
			max_attempts: s.max_attempts,
			anchor_attempts: s.anchor_attempts,
			concurrency: s.concurrency,
			vision_judge: s.vision_judge,
			use_git: s.use_git
		});
	},
	validate: ({ workingDir, config }) => {
		const s = config as unknown as AssetGenerationEditorState;
		if (!workingDir.trim()) {
			return 'Asset generation needs a working directory — the project to write assets into.';
		}
		if (!s.spec_path.trim()) return 'A spec path is required.';
		// Clamped by the parser, rejected here: a user typing 30 should be told
		// rather than silently given 32.
		if (
			!isPowerOfTwo(s.target_size) ||
			s.target_size < MIN_TARGET_SIZE ||
			s.target_size > MAX_TARGET_SIZE
		) {
			return `Asset size must be a power of two between ${MIN_TARGET_SIZE} and ${MAX_TARGET_SIZE}.`;
		}
		if (!Number.isFinite(s.max_attempts) || s.max_attempts < 1 || s.max_attempts > 10) {
			return 'Attempts per asset must be between 1 and 10.';
		}
		if (!Number.isFinite(s.anchor_attempts) || s.anchor_attempts < 1 || s.anchor_attempts > 10) {
			return 'Anchor attempts must be between 1 and 10.';
		}
		if (!Number.isFinite(s.concurrency) || s.concurrency < 1 || s.concurrency > 8) {
			return 'Simultaneous requests must be between 1 and 8.';
		}
		return null;
	},
	planSteps: planAssetSteps,
	runPipeline: runAssetGenerationPipeline
};
