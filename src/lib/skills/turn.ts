/**
 * Skills for one turn: which ones the model may load by itself, and the
 * system-prompt section that tells it so.
 *
 * Built by the Chat and Shell stores and handed to the agent loop as
 * `AgentLoopOptions.skills`. Jobs and remote guests never build one, so they
 * get neither the section nor the tools — the scope is set by who calls
 * this, the same way `memorySection` is.
 */

import type { BackendOverride } from '#lib/api.ts';
import { listSkills, skillsAutonomous, usableSkills } from './client';

export interface TurnSkills {
	/**
	 * Skills the model may load by itself, by name and description. Empty
	 * when autonomous use is off or none is usable: the turn still carries
	 * skills the user ran with `/name`, and may read their files.
	 */
	catalog: { name: string; description: string }[];
	/** The trusted repo the turn's project skills come from, if any. */
	projectRoot: string | null;
}

/**
 * The turn's skills. The catalog is empty when the model shouldn't pick any
 * by itself: autonomous use is off for this backend, or no usable skill
 * exists. A failure to list skills costs the turn its catalog, not the turn.
 */
export async function prepareTurnSkills(opts: {
	backend?: BackendOverride;
	/** Code mode: the trusted repo (`trustedProjectRoot`) whose skills count. */
	projectRoot?: string | null;
}): Promise<TurnSkills> {
	const projectRoot = opts.projectRoot ?? null;
	if (!skillsAutonomous(opts.backend)) return { catalog: [], projectRoot };
	const all = await listSkills(projectRoot).catch(() => []);
	const catalog = usableSkills(all).map((s) => ({ name: s.name, description: s.description }));
	return { catalog, projectRoot };
}

/** The system-prompt section listing the turn's skills; empty without any. */
export function skillsPromptSection(skills: TurnSkills | undefined): string {
	if (!skills?.catalog.length) return '';
	const list = skills.catalog.map((s) => `- ${s.name}: ${s.description}`).join('\n');
	return `

SKILLS:
These skills hold instructions for specific tasks. When the request matches one, call load_skill with its name before you start, then follow what it says. A skill already in the conversation inside <skill_content> is loaded: follow it without calling load_skill.
${list}`;
}
