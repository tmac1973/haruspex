/**
 * A planning skill in a guided planning run: one skill the user picked in the
 * editor, whose `## Questions` the overview interview covers and whose
 * `## Plan requirements` the outline and the verifier hold the plan to.
 *
 * Read once when the run starts and kept for the whole run, so editing the
 * skill mid-run changes nothing a later stage sees.
 */

import { readSkill } from '#lib/skills/client.ts';
import { knownTrustedRoot } from '#lib/skills/project.ts';
import { errMessage } from '#lib/utils/error.ts';

export interface PlanningSkill {
	name: string;
	body: string;
}

/**
 * The skill `name`, with the job's repo's skills counted when the user
 * trusts it. Throws a message fit for the run's error.
 */
export async function loadPlanningSkill(
	name: string,
	workingDir: string | null
): Promise<PlanningSkill> {
	try {
		const doc = await readSkill(name, await knownTrustedRoot(workingDir));
		return { name: doc.name, body: doc.body };
	} catch (e) {
		throw new Error(
			`Couldn't read the planning skill "${name}": ${errMessage(e)}. ` +
				'Pick another in the job editor, or none.'
		);
	}
}

/**
 * The skill's `## Plan requirements` section, without its heading, or null
 * when it has none. Runs to the next `## ` heading or the end.
 */
export function planRequirements(body: string): string | null {
	const lines = body.split('\n');
	const start = lines.findIndex((l) => /^##\s+plan requirements\s*$/i.test(l.trim()));
	if (start < 0) return null;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => /^##\s/.test(l));
	const section = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
	return section || null;
}

/** For the overview interview: the whole skill, and how to use it. */
export function interviewSkillSection(skill: PlanningSkill): string {
	return [
		'',
		`PLANNING SKILL "${skill.name}" (chosen by the user for this kind of project):`,
		'In step 2, ALSO settle every topic under its Questions that the project',
		'description does not already answer, on top of the topics listed there.',
		"Offer the skill's usual options, recommended first, adapted to choices",
		'already made. Skip a topic that clearly does not apply. Under ## Decisions,',
		'list a topic the description already answered as "(from the description)".',
		'"Proceed" from the user still ends the interview at once.',
		'Its Plan requirements apply to the plan written in stage 2; the overview',
		'must not contradict them unless the user chose otherwise.',
		'',
		`<skill_content name="${skill.name}">`,
		skill.body.trim(),
		'</skill_content>'
	].join('\n');
}

/** For the outline turns: the requirements every phase list must meet. */
export function outlineRequirementsSection(skill: PlanningSkill): string {
	const req = planRequirements(skill.body);
	if (!req) return '';
	return [
		'',
		`PLAN REQUIREMENTS (from the "${skill.name}" planning skill the user chose):`,
		'The phases must meet every one of these, in the phase the requirement',
		"names, unless the overview's ## Decisions records the user choosing",
		'otherwise. Say in a phase summary which requirement it meets when that is',
		'not obvious.',
		req
	].join('\n');
}

/** For the verifier: the fifth kind of problem, and what to check it against. */
export function verifierRequirements(skill: PlanningSkill | null): string | null {
	return skill ? planRequirements(skill.body) : null;
}
