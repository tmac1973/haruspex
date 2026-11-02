/**
 * `text`: ask a model a question and hand its answer back as text. For any
 * small model with no output of its own to handle (SQL, regex, translation).
 */
import { toolResult } from '#lib/agent/tools/types.ts';
import { stripThinkBlocks } from '#lib/markdown.ts';
import { callOptionsFrom, callSpecialist } from '#lib/specialists/call.ts';
import { registerSpecialistKind } from '#lib/specialists/kinds.ts';

/** The longest answer handed back, so one call cannot fill the context. */
export const MAX_ANSWER_CHARS = 24_000;

/** The answer as the main model gets it. */
export function textAnswer(content: string): string {
	const answer = stripThinkBlocks(content).trim();
	if (answer.length <= MAX_ANSWER_CHARS) return answer;
	return `${answer.slice(0, MAX_ANSWER_CHARS)}\n\n(answer cut at ${MAX_ANSWER_CHARS.toLocaleString('en')} characters)`;
}

registerSpecialistKind({
	id: 'text',
	label: 'Text',
	summary: "Returns the model's answer as text.",
	defaultDescription: 'Answers a question or writes a short piece of text.',
	defaultSystemPrompt: '',
	defaultSampling: { temperature: 0.7, max_tokens: 4096 },
	writes: false,
	params: {},
	requestRequired: true,
	async run({ entry, request, images, ctx }) {
		const answer = await callSpecialist(entry, request ?? '', {
			...callOptionsFrom(ctx),
			images
		});
		return toolResult(textAnswer(answer.content));
	}
});
