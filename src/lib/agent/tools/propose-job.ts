/**
 * `propose_job`: the model drafts a job from what the chat settled, and the
 * Jobs tab opens it unsaved. Nothing is saved, scheduled or run: the user
 * reads it, saves it and presses Run. A model that starts hours of GPU work
 * by itself is what this keeps out.
 *
 * Offered in interactive Chat and Code-tab turns, to someone at this computer.
 * The job types it can draft are the ones with a `propose` entry; each checks
 * the draft with its own `validate` (`agent/jobs/proposal.ts`).
 *
 * The job-type registry is loaded when the tool runs, not imported here: the
 * job pipelines import the agent loop, which imports every tool module.
 */
import { invoke } from '@tauri-apps/api/core';
import { ctxHostCwd } from '#lib/agent/tools/_helpers.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import {
	toolError,
	toolResult,
	type ToolContext,
	type ToolExecOutput
} from '#lib/agent/tools/types.ts';
import { draftFromProposal, type ProposalArgs } from '#lib/agent/jobs/proposal.ts';
import { openJobDraft } from '#lib/agent/jobs/openDraft.ts';
import { errMessage } from '#lib/utils/error.ts';

export const PROPOSE_JOB_TOOL = 'propose_job';

/** The types with a `propose` entry. A test holds this to the registry. */
export const PROPOSABLE_TYPES = [
	'research',
	'audit',
	'guided_planning',
	'asset_generation',
	'model_generation',
	'video_sequence',
	'autonomous_coding'
] as const;

function stringList(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string');
	return typeof v === 'string' && v.trim() ? [v] : [];
}

/** The model's arguments, as the builder takes them. */
export function proposalArgs(args: Record<string, unknown>, ctx: ToolContext): ProposalArgs {
	const given = typeof args.working_dir === 'string' ? args.working_dir.trim() : '';
	const settings =
		args.settings && typeof args.settings === 'object' && !Array.isArray(args.settings)
			? (args.settings as Record<string, unknown>)
			: {};
	return {
		name: typeof args.name === 'string' ? args.name : '',
		// The Code tab's project, unless the model named another folder.
		workingDir: given || (ctx.codeMode ? (ctxHostCwd(ctx) ?? '') : (ctx.workingDir ?? '')),
		brief: typeof args.brief === 'string' ? args.brief : '',
		steps: stringList(args.steps),
		settings,
		spec: typeof args.spec === 'string' ? args.spec : null
	};
}

async function proposeJob(
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<ToolExecOutput> {
	if (ctx.wslDistro) {
		return toolResult(toolError("Jobs work in this computer's folders, not inside WSL."));
	}
	const jobType = String(args.job_type ?? '');
	const types = await import('#lib/agent/jobs/types/index.ts');
	await types.ensureTypeAvailabilityLoaded();
	const def = types.getJobType(jobType);
	if (!def?.propose) {
		return toolResult(toolError(`job_type takes ${PROPOSABLE_TYPES.join(', ')}.`));
	}
	if (!types.isJobTypeAvailable(def.id)) {
		return toolResult(
			toolError(`${def.label} jobs aren't available here: their backend or platform is missing.`)
		);
	}
	const built = draftFromProposal(def, proposalArgs(args, ctx));
	if ('error' in built) return toolResult(toolError(`Nothing was opened. ${built.error}`));
	const { draft } = built;
	const specPath = draft.spec !== undefined ? def.propose.spec?.path(draft.config) : undefined;
	if (specPath) {
		let exists: boolean;
		try {
			exists = await invoke<boolean>('fs_path_exists', {
				workdir: draft.workingDir,
				relPath: specPath
			});
		} catch (e) {
			return toolResult(toolError(`Nothing was opened: ${errMessage(e)}.`));
		}
		if (exists) {
			return toolResult(
				toolError(
					`Nothing was opened: ${specPath} already exists. Leave spec out to use it, or set settings.spec_path to a new file.`
				)
			);
		}
	}
	try {
		await openJobDraft(draft);
	} catch (e) {
		return toolResult(toolError(`Couldn't open the Jobs tab: ${errMessage(e)}.`));
	}
	const spec = specPath ? ` Saving it writes the spec to ${specPath}.` : '';
	return toolResult(
		`Opened a new ${def.label} job, "${draft.name}", in the Jobs tab. It is not saved and nothing runs until the user saves it and presses Run there.${spec} Tell the user it is ready to review.`
	);
}

registerTool({
	category: 'job-proposal',
	schema: {
		type: 'function',
		function: {
			name: PROPOSE_JOB_TOOL,
			description:
				'Draft a job from this conversation and open it in the Jobs tab for the user to review. The user saves and runs it; nothing runs, and there is no schedule, until they do. Use it when the user asks for a job, or agrees to one, for work too long for this chat: research with several steps (research), planning a project (guided_planning), auditing code (audit), game art (asset_generation), 3D models (model_generation), a long generated video (video_sequence), or building from plan files (autonomous_coding). A wrong setting or a draft the job type rejects comes back with what to fix.',
			parameters: {
				type: 'object',
				properties: {
					job_type: { type: 'string', enum: [...PROPOSABLE_TYPES] },
					name: { type: 'string', description: 'A short name for the job.' },
					working_dir: {
						type: 'string',
						description:
							'The folder the job works in, as an absolute path. In the Code tab, leave it out for the project folder.'
					},
					brief: {
						type: 'string',
						description:
							'What this conversation settled: the goal, and every decision and answer the user gave, so the job does not ask again. For guided_planning it is what to plan, for audit what to look for, for asset_generation and model_generation what to make, for video_sequence what the video is.'
					},
					steps: {
						type: 'array',
						items: { type: 'string' },
						description:
							"research only: the step prompts in order. Each runs as a fresh conversation and gets the previous step's output, so each says everything it needs."
					},
					settings: {
						type: 'object',
						description:
							'Settings of the job type by name, such as {"verification": "lite"}. Leave out what should stay at its default. A wrong name returns the list.'
					},
					spec: {
						type: 'string',
						description:
							"asset_generation, model_generation and video_sequence only: the spec file's JSON, when this conversation wrote one. It is written when the user saves. Leave it out and the run writes the spec from the brief."
					}
				},
				required: ['job_type', 'name']
			}
		}
	},
	displayLabel: (args) => String(args.name ?? ''),
	execute: proposeJob
});
