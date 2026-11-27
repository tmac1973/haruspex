/**
 * The IMAGE MODELS block of Chat's prompt: the image models, in the order the
 * tools try them, each with what it can do (`entryLine`). With one model there
 * is nothing to choose and no block; the tools' `model` argument is offered on
 * the same terms (`#lib/agent/tools/_imageModel.ts`).
 */

import { imageEntries } from '#lib/image/entries.ts';
import { entryLine } from '#lib/image/capabilityLine.ts';
import { upscalerEntries } from '#lib/upscale/entries.ts';

/**
 * The image upscalers that are on, as one line: empty with none. Chat's
 * prompt and an image skill's "Set up now" both say it, so the model knows
 * `upscale_image` can run.
 */
export function upscalersLine(): string {
	const ups = upscalerEntries('image').map((e) =>
		e.caps ? `${e.name} (×${e.caps.scale})` : e.name
	);
	return ups.length ? `Upscalers, which upscale_image tries first: ${ups.join(', ')}.` : '';
}

export function imageModelsPrompt(): string {
	const entries = imageEntries();
	if (entries.length < 2) return '';
	const ups = upscalersLine();
	const upLine = ups ? `\n- ${ups}` : '';
	return `

IMAGE MODELS, in the order the image tools use them:
${entries.map((e) => `- ${entryLine(e)}`).join('\n')}${upLine}
- The tools pick the first model that can do the job. Pass \`model\` only when the user names one.`;
}
