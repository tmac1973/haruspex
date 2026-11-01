/**
 * The IMAGE MODELS block of Chat's prompt: the image models, in the order the
 * tools try them, each with what it can do (`entryLine`). With one model there
 * is nothing to choose and no block; the tools' `model` argument is offered on
 * the same terms (`#lib/agent/tools/_imageModel.ts`).
 */

import { imageEntries } from '#lib/image/entries.ts';
import { entryLine } from '#lib/image/capabilityLine.ts';

export function imageModelsPrompt(): string {
	const entries = imageEntries();
	if (entries.length < 2) return '';
	return `

IMAGE MODELS, in the order the image tools use them:
${entries.map((e) => `- ${entryLine(e)}`).join('\n')}
- The tools pick the first model that can do the job. Pass \`model\` only when the user names one.`;
}
