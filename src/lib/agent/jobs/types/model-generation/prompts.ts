/** Prompts for the 3D models job. */

import { SUBMIT_MODEL_SPEC_TOOL } from '#lib/agent/jobs/types/model-generation/tools.ts';
import { MAX_ENTRIES } from '#lib/models3d/spec/types.ts';

/** The spec stage's system prompt: list the models from the user's description. */
export function modelSpecPrompt(description: string, specPath: string): string {
	return [
		'You are listing the 3D models a project needs, so they can be built in code.',
		'',
		`What the user asked for: ${description}`,
		'',
		'Process:',
		'1. Look at the working directory first. If there is content on disk (a plan,',
		'   data files, source that loads models), read it and let it decide the list.',
		'2. Decide one shared style line: polygon level, shading and palette feel,',
		'   e.g. "low-poly, flat colours, chunky proportions". No subject.',
		`3. List one entry per distinct model, at most ${MAX_ENTRIES}. Each entry:`,
		'   - title: what it is, two or three words.',
		'   - description: its shape, main parts and colours, in one or two sentences.',
		'   - height_m: its overall height in metres, so the set shares one scale',
		'     (a door is about 2, a person 1.8, a crate 0.6).',
		'   - parts and clips only for a model that moves. parts are the pivot names',
		'     at its joints, written Side_Part: Hip_L, Knee_L, Hip_R, Knee_R,',
		'     Shoulder_L, Elbow_L, Neck. Every pivot a clip moves must be listed.',
		'   - clips: name, seconds (0.2 to 10), loop, and action (what happens).',
		'   - A static prop (crate, tree, rock) has no parts and no clips.',
		'',
		`The runner writes the result to ${specPath}, gives each entry its id and`,
		`folder, and checks it. Call \`${SUBMIT_MODEL_SPEC_TOOL}\` once, at the end.`
	].join('\n');
}

/** The retry message: the problems the last submission had. */
export function modelSpecRetryPrompt(problems: string[]): string {
	return [
		'That spec has problems:',
		'',
		...problems.map((p) => `- ${p}`),
		'',
		`Call \`${SUBMIT_MODEL_SPEC_TOOL}\` again with the whole list corrected. Do not explain;`,
		'submit.'
	].join('\n');
}
