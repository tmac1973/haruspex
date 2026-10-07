/**
 * `create_skill` and `update_skill`: the model saving a procedure as a skill,
 * or improving one, when the user asks it to.
 *
 * Every write opens the approval modal with the full `SKILL.md`, which the
 * user can edit first. A request Rust turns back (a bad name, a name in use, a
 * skill that belongs to another tool) goes back to the model with the reason
 * and never reaches the user.
 *
 * Offered only in interactive Chat and Shell turns: those that carry
 * `ToolContext.skills` with someone there to approve. Not tied to the
 * autonomous-use setting, since "save that as a skill" is an explicit request.
 * The registry re-checks at execution, because a model can emit a call it was
 * never offered.
 *
 * Per the CI grep guard, nothing under `tools/` may import `stores/chat`.
 */

import type { SkillWriteRequest } from '#lib/ipc/gen/SkillWriteRequest.ts';
import { draftSkill, saveSkill } from '#lib/skills/client.ts';
import { noteProjectSkill } from '#lib/skills/project.ts';
import { askSkillApproval } from '#lib/stores/skillApproval.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from './registry';
import { toolError, toolResult, type ToolContext, type ToolExecOutput } from './types';

export const CREATE_SKILL_TOOL = 'create_skill';
export const UPDATE_SKILL_TOOL = 'update_skill';

const BODY_DESCRIPTION =
	'The instructions, in Markdown: the steps to follow and anything to watch for, written so they work without this conversation.';

registerTool({
	category: 'skills-write',
	schema: {
		type: 'function',
		function: {
			name: CREATE_SKILL_TOOL,
			description:
				'Save a procedure as a new skill the user can run later with /name. Use only when the user asks for a skill to be saved. The user reviews the text before it is saved.',
			parameters: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
						description: 'Lowercase letters, digits and hyphens, e.g. deploy-check.'
					},
					description: {
						type: 'string',
						description: 'One or two sentences: what the skill does and when to use it.'
					},
					body: { type: 'string', description: BODY_DESCRIPTION },
					where: {
						type: 'string',
						enum: ['user', 'project'],
						description:
							"'project' saves it in this repo's .agents/skills/ for everyone working on it; 'user' (the default) keeps it to this user."
					}
				},
				required: ['name', 'description', 'body']
			}
		}
	},
	displayLabel: (args) => String(args.name ?? ''),
	execute: (args, ctx) =>
		writeSkill(ctx, {
			update: false,
			name: String(args.name ?? ''),
			description: typeof args.description === 'string' ? args.description : '',
			body: String(args.body ?? ''),
			project: args.where === 'project'
		})
});

registerTool({
	category: 'skills-write',
	schema: {
		type: 'function',
		function: {
			name: UPDATE_SKILL_TOOL,
			description:
				"Replace an existing skill's instructions, and optionally its description. Use only when the user asks for a skill to be changed. The user reviews the change before it is saved.",
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The skill to change.' },
					description: {
						type: 'string',
						description: 'A new description. Leave it out to keep the current one.'
					},
					body: {
						type: 'string',
						description: `${BODY_DESCRIPTION} Replaces the current instructions in full.`
					}
				},
				required: ['name', 'body']
			}
		}
	},
	displayLabel: (args) => String(args.name ?? ''),
	execute: (args, ctx) =>
		writeSkill(ctx, {
			update: true,
			name: String(args.name ?? ''),
			description: typeof args.description === 'string' ? args.description : null,
			body: String(args.body ?? ''),
			project: false
		})
});

async function writeSkill(ctx: ToolContext, request: SkillWriteRequest): Promise<ToolExecOutput> {
	// A repo's skills folder is only in reach from Code mode, where the turn
	// knows which repo it is in and the user trusts it.
	if (request.project && !ctx.codeMode) {
		return toolResult(
			toolError("Project skills can only be saved in Code mode. Leave out 'where'.")
		);
	}
	const projectRoot = ctx.skills?.projectRoot ?? null;
	let draft;
	try {
		draft = await draftSkill(request, projectRoot);
	} catch (e) {
		return toolResult(toolError(`Nothing was saved: ${errMessage(e)}.`));
	}
	let path = '';
	const result = await askSkillApproval(
		{
			update: request.update,
			name: request.name,
			dir: draft.dir,
			project: request.project,
			text: draft.text,
			current: draft.current,
			save: async (text) => {
				path = await saveSkill(request, text, projectRoot);
			}
		},
		ctx.signal
	);
	if (result.kind === 'rejected') {
		const why = result.reason.trim();
		return toolResult(
			toolError(`The user declined, and nothing was saved.${why ? ` Their reason: ${why}` : ''}`)
		);
	}
	if (request.project && projectRoot) noteProjectSkill(projectRoot, request.name);
	const edited = result.edited ? ' The user edited it before saving.' : '';
	return toolResult(
		`Saved the "${request.name}" skill to ${path}.${edited} The user can run it with /${request.name}.`
	);
}
