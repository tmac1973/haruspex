import { videoEntries } from '#lib/videogen/entries.ts';
import type { JobTypeDefinition, PlannedStep } from '#lib/agent/jobs/types/types.ts';
import { refreshVideoBinaries, videoToolsOn } from '#lib/video/binaries.ts';
import { parseSequenceSpec } from '#lib/sequence/spec/parse.ts';
import { runVideoSequencePipeline } from '#lib/agent/jobs/types/video-sequence/pipeline.ts';
import {
	configDefaults,
	configProblem,
	configToJson,
	parseConfig,
	specPathFor,
	MAX_REANCHOR,
	type VideoSequenceConfig
} from '#lib/agent/jobs/types/video-sequence/config.ts';
import Editor from '#lib/agent/jobs/types/video-sequence/Editor.svelte';

/**
 * Display stages, in step-index order: the pipeline's constants (INTERVIEW =
 * 0, …) must match. All ten from the start, so the phases that fill them in
 * never move an index.
 */
export const SEQUENCE_STAGES: ReadonlyArray<{ title: string; description: string }> = [
	{
		title: 'Interview',
		description: 'Asking, one question at a time, what the brief leaves open. Attended runs only.'
	},
	{
		title: 'Spec',
		description:
			'Writing sequence.json from the brief: the sections, how they join, and the sound. Attended runs stop here to show it.'
	},
	{ title: 'Speech', description: 'Speaking the lines of speaking sections.' },
	{ title: 'Keyframes', description: 'Making an opening still for each generated section.' },
	{ title: 'Generate', description: 'Making the clips, each continuing from the one before.' },
	{ title: 'Check', description: 'Looking at each seam with a vision model.' },
	{ title: 'Sound', description: 'Making the music and the narration.' },
	{ title: 'Assemble', description: 'Cutting everything into one Shotcut or Kdenlive project.' },
	{ title: 'Render', description: 'Rendering the video.' },
	{ title: 'Report', description: 'Writing REPORT-sequence.md: what was made and what was not.' }
];

function planSequenceSteps(): PlannedStep[] {
	return SEQUENCE_STAGES.map((s) => ({
		authored: s.title,
		deepResearch: false,
		description: s.description
	}));
}

/** Whether a run can start: the video tools on and video generation set up. */
export async function sequenceAvailable(): Promise<boolean> {
	if (videoEntries().length === 0) return false;
	await refreshVideoBinaries().catch(() => null);
	return videoToolsOn();
}

const asConfig = (c: Record<string, unknown>) => c as unknown as VideoSequenceConfig;

export const videoSequenceJobType: JobTypeDefinition = {
	id: 'video_sequence',
	label: 'Video sequence',
	description:
		'Turns a brief into one long generated video: sections of chained clips, joins, sound, and a Shotcut or Kdenlive project.',
	hasPlannedSteps: false,
	// The interview and the spec checkpoint wait on the user.
	supportsSchedule: false,
	available: sequenceAvailable,
	workingDirPlaceholder: 'The series or episode folder the video goes in',
	Editor,
	configDefaults: () => ({ ...configDefaults() }),
	configFromJob: (typeConfig) => ({ ...parseConfig(typeConfig) }),
	configToJson: (config) => configToJson(asConfig(config)),
	validate: ({ workingDir, config }) => configProblem(asConfig(config), workingDir),
	missingRequired: ({ config }) => (asConfig(config).brief.trim() ? [] : ['Brief']),
	propose: {
		settings: {
			episode_dir: {
				help: 'The episode folder, relative to the working folder. Empty when the working folder is the episode.'
			},
			run_mode: {
				help: 'attended asks what the brief leaves open and stops to show the spec; unattended does neither. Default attended.',
				values: ['attended', 'unattended']
			},
			image_keyframes: {
				help: 'Open each generated section on a still from the image backend. Default true.'
			},
			vision_checks: { help: 'Check each seam with a vision model. Default true.' },
			reanchor_every: {
				help: `End every this-many clips of a section on a fresh still, 0 to ${MAX_REANCHOR}. Default 6.`
			},
			editor: {
				help: 'The project editor; empty for Settings → Video editing.',
				values: ['', 'shotcut', 'kdenlive']
			}
		},
		brief: (draft, brief) => ({ ...draft, config: { ...draft.config, brief } }),
		spec: {
			path: (config) => specPathFor(parseConfig(JSON.stringify(config))),
			problems: (text) => parseSequenceSpec(text).problems
		}
	},
	// Every clip is on disk as soon as it is made: running again carries on.
	canResume: (run) => run.status === 'failed' || run.status === 'cancelled',
	planSteps: planSequenceSteps,
	runPipeline: runVideoSequencePipeline
};
