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
	/** Skills the model may load, by name and description. Never empty. */
	catalog: { name: string; description: string }[];
	/** The trusted repo the turn's project skills come from, if any. */
	projectRoot: string | null;
}

/**
 * The turn's skills, or undefined when the model shouldn't see any: autonomous
 * use is off for this backend, or no usable skill exists. A failure to list
 * skills costs the turn its skills, not the turn.
 */
export async function prepareTurnSkills(opts: {
	backend?: BackendOverride;
	/** Code mode: the trusted repo (`trustedProjectRoot`) whose skills count. */
	projectRoot?: string | null;
}): Promise<TurnSkills | undefined> {
	if (!skillsAutonomous(opts.backend)) return undefined;
	const projectRoot = opts.projectRoot ?? null;
	const all = await listSkills(projectRoot).catch(() => []);
	const catalog = usableSkills(all).map((s) => ({ name: s.name, description: s.description }));
	return catalog.length > 0 ? { catalog, projectRoot } : undefined;
}

/** The system-prompt section listing the turn's skills; empty without any. */
export function skillsPromptSection(skills: TurnSkills | undefined): string {
	if (!skills) return '';
	const list = skills.catalog.map((s) => `- ${s.name}: ${s.description}`).join('\n');
	return `

SKILLS:
These skills hold instructions for specific tasks. When the request matches one, call load_skill with its name before you start, then follow what it says.
${list}`;
}
