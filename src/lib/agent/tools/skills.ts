/**
 * `load_skill` and `read_skill_file`: the model loading a skill's
 * instructions, then the files they point at.
 *
 * Offered only to a turn that carries skills (`ToolContext.skills`) — Chat and
 * Shell, with autonomous use on — and the registry narrows `name` to an enum
 * of that turn's skills, so the model can't call one that doesn't exist. The
 * executors re-check, because a model can emit a call it was never offered.
 *
 * Per the CI grep guard, nothing under `tools/` may import `stores/chat`.
 */

import { readSkill, readSkillFile } from '#lib/skills/client.ts';
import { renderSkillContent } from '#lib/skills/content.ts';
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from './registry';
import { toolError, toolResult, type ToolContext } from './types';

export const LOAD_SKILL_TOOL = 'load_skill';
export const READ_SKILL_FILE_TOOL = 'read_skill_file';

/** The turn's skills, or the error to return when `name` isn't one of them. */
function checkSkill(ctx: ToolContext, name: unknown): string | null {
	if (!ctx.skills) return 'Skills are not available in this conversation.';
	if (typeof name !== 'string' || !ctx.skills.names.includes(name)) {
		return `No skill named "${String(name)}". Available: ${ctx.skills.names.join(', ')}.`;
	}
	return null;
}

registerTool({
	category: 'skills',
	schema: {
		type: 'function',
		function: {
			name: LOAD_SKILL_TOOL,
			description:
				"Load a skill's full instructions. Call it when the request matches a skill listed in the system prompt, then follow the instructions it returns.",
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The skill to load.' }
				},
				required: ['name']
			}
		}
	},
	displayLabel: (args) => String(args.name ?? ''),
	async execute(args, ctx) {
		const problem = checkSkill(ctx, args.name);
		if (problem) return toolResult(toolError(problem));
		const name = args.name as string;
		if (ctx.skills!.loaded.has(name)) {
			return toolResult(
				`The "${name}" skill is already loaded earlier in this conversation. Follow those instructions.`
			);
		}
		try {
			const doc = await readSkill(name, ctx.skills!.projectRoot);
			ctx.skills!.loaded.add(name);
			return toolResult(renderSkillContent(doc));
		} catch (e) {
			return toolResult(toolError(`Could not load the "${name}" skill: ${errMessage(e)}`));
		}
	}
});

registerTool({
	category: 'skills',
	schema: {
		type: 'function',
		function: {
			name: READ_SKILL_FILE_TOOL,
			description:
				"Read a file that belongs to a skill, such as a reference or script its instructions mention. The path is relative to the skill's directory.",
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The skill the file belongs to.' },
					path: {
						type: 'string',
						description: 'Path inside the skill, e.g. references/guide.md.'
					}
				},
				required: ['name', 'path']
			}
		}
	},
	displayLabel: (args) => `${String(args.name ?? '')}/${String(args.path ?? '')}`,
	async execute(args, ctx) {
		const problem = checkSkill(ctx, args.name);
		if (problem) return toolResult(toolError(problem));
		try {
			const text = await readSkillFile(
				args.name as string,
				String(args.path ?? ''),
				ctx.skills!.projectRoot
			);
			return toolResult(text);
		} catch (e) {
			return toolResult(toolError(errMessage(e)));
		}
	}
});
