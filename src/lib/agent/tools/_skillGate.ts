/**
 * A skill that covers a tool (`metadata.haruspex-tools`) is loaded by that
 * tool's first call, in place of running it.
 *
 * Measured: with `fix-picture` in the skill list, Qwen3.8-Flash called
 * `edit_image` straight away in 12 of 12 replays and never loaded the skill,
 * and no wording of the skill list got it past about 7 in 8. Where the
 * conversation already held an edit made without the skill, it never did:
 * the model follows its own earlier turns. So the app loads it: the call
 * comes back with the skill's instructions and is made again by them.
 */

import { readSkillForTurn } from '#lib/skills/client.ts';
import { renderSkillContent } from '#lib/skills/content.ts';
import { toolResult, type ToolContext, type ToolExecOutput } from '#lib/agent/tools/types.ts';

/** What follows the skill, in place of the call's result. */
export function gateNote(tool: string, skill: string): string {
	return (
		`This ${tool} call was not run. The "${skill}" skill covers ${tool}, and its ` +
		'instructions are above. Follow them: make the call again as they say, or answer ' +
		'instead if they say to.'
	);
}

/**
 * The skill, when `tool` is covered by one this turn may load that isn't
 * loaded yet; null to run the call. A skill that can't be read lets the call
 * run, rather than blocking a tool behind instructions nobody can see.
 */
export async function skillGate(tool: string, ctx: ToolContext): Promise<ToolExecOutput | null> {
	const skills = ctx.skills;
	const skill = skills?.covers?.get(tool);
	if (!skills || !skill || skills.loaded.has(skill) || !skills.names.includes(skill)) return null;
	// Marked first, so a second covered call in the same parallel batch runs
	// rather than loading another copy.
	skills.loaded.add(skill);
	try {
		const doc = await readSkillForTurn(skill, skills.projectRoot);
		return toolResult(`${renderSkillContent(doc)}\n\n${gateNote(tool, skill)}`);
	} catch (e) {
		console.warn(`Could not load the ${skill} skill for ${tool}`, e);
		return null;
	}
}
