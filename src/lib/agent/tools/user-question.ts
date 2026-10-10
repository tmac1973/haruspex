import { registerTool } from './registry';
import { toolResult, toolError, type UserAnswer } from './types';

/**
 * `ask_user_question` — the agent-facing half of the reusable human-in-the-loop
 * primitive. Pops the `UserQuestionModal` (via the userQuestion store) and
 * returns the user's answer as the tool result. Available everywhere: the
 * default chat toolset (category 'interaction' falls through the chat filter)
 * and, via an explicit allowlist, jobs.
 *
 * Non-interactive contexts (a background/scheduled job with no user present)
 * can't show a modal. This fails safe with an error result rather than hanging.
 * Phase 05 replaces that branch, for guided-planning jobs, with a
 * pause-to-needs-input signal once job-run state exists to support it.
 */

interface QuestionOptionArg {
	label?: unknown;
	description?: unknown;
	recommended?: unknown;
}

registerTool({
	category: 'interaction',
	schema: {
		type: 'function',
		function: {
			name: 'ask_user_question',
			description:
				'Ask the user one question with a list of choices and wait for their answer. ' +
				'By default the user picks ONE choice. For a "which of these…" question where ' +
				'several choices can apply at once (features to include, platforms to support), ' +
				'set allow_multiple to true and the user gets checkboxes. Ask exactly ONE ' +
				'question per call. The user can always type their own answer as well, so offer ' +
				'the most likely choices rather than trying to be exhaustive. Use this only to ' +
				'resolve a genuine decision you cannot make confidently from context — not for ' +
				'trivia, and not to confirm things the user already told you.',
			parameters: {
				type: 'object',
				properties: {
					question: { type: 'string', description: 'The question to ask the user.' },
					body: {
						type: 'string',
						description:
							'Longer context shown under the question, in markdown — keep the question itself one sentence.'
					},
					options: {
						type: 'array',
						description: 'The choices to offer (2–6 is ideal).',
						items: {
							type: 'object',
							properties: {
								label: { type: 'string', description: 'Short choice text.' },
								description: {
									type: 'string',
									description: 'Optional one-line explanation of the choice.'
								},
								recommended: {
									type: 'boolean',
									description: 'Optionally mark this as the suggested choice.'
								}
							},
							required: ['label']
						}
					},
					allow_multiple: {
						type: 'boolean',
						description:
							'true when several options can be chosen together (checkboxes); omit or false for a single choice.'
					}
				},
				required: ['question', 'options']
			}
		}
	},
	displayLabel: (args) => {
		const q = typeof args.question === 'string' ? args.question : '';
		return `ask: ${q.slice(0, 60)}`;
	},
	async execute(args, ctx) {
		const question = typeof args.question === 'string' ? args.question.trim() : '';
		if (!question) {
			return toolResult(toolError('ask_user_question requires a non-empty "question".'));
		}

		const rawOptions = Array.isArray(args.options) ? (args.options as QuestionOptionArg[]) : [];
		const options = rawOptions
			.map((o) => ({
				label: typeof o?.label === 'string' ? o.label.trim() : '',
				description: typeof o?.description === 'string' ? o.description : undefined,
				recommended: o?.recommended === true
			}))
			.filter((o) => o.label.length > 0);

		// Say so, rather than showing a question with nothing to pick.
		//
		// This used to fall through to a free-text-only modal, which looks like
		// a deliberate open question and is indistinguishable from one. A real
		// run spent an entire interview that way, because the model emitted
		// `options` as a malformed JSON string and every call silently lost it.
		// Erroring costs one round trip and tells the model exactly what to fix.
		if (options.length === 0) {
			const got =
				args.options === undefined
					? 'nothing'
					: `a ${Array.isArray(args.options) ? 'list with no usable labels' : typeof args.options}`;
			return toolResult(
				toolError(
					`ask_user_question got ${got} for "options". Pass a real JSON array of ` +
						`objects, each with a non-empty "label" and optionally a "description" ` +
						`and "recommended" — not a string containing JSON, and not an empty ` +
						`list. The user can always type their own answer instead of picking, ` +
						`so offer the likely choices rather than trying to be exhaustive.`
				)
			);
		}

		// A caller with its own route to a human (a remote chat guest) supplies
		// one; otherwise the modal in this window is the only route, and without
		// somebody in front of it the tool fails safe rather than hanging.
		// Phase 05 upgrades this to a pause-to-needs-input signal for
		// guided-planning jobs.
		if (!ctx.askUser && !ctx.interactive) {
			return toolResult(
				toolError('No interactive user is available to answer questions in this context.')
			);
		}

		const ask = ctx.askUser ?? (await import('#lib/stores/userQuestion.svelte.ts')).askUserQuestion;
		const answer = await ask(
			{
				question,
				...(typeof args.body === 'string' && args.body.trim() ? { body: args.body.trim() } : {}),
				options,
				allowMultiple: args.allow_multiple === true,
				...(ctx.codeSessionId ? { sessionId: ctx.codeSessionId } : {})
			},
			ctx.signal
		);

		return toolResult(describeAnswer(answer, args.allow_multiple === true));
	}
});

/**
 * The answer as the model reads it. A multi-select answer is a list, one
 * choice per line, so a label containing a comma cannot be misread as two;
 * a note the user added alongside their ticks follows it.
 */
export function describeAnswer(answer: UserAnswer, multiple: boolean): string {
	if (answer.kind === 'freeText') return `The user wrote a custom answer: ${answer.text}`;
	const note = answer.note?.trim() ? `\nThey also wrote: ${answer.note.trim()}` : '';
	if (!multiple) return `The user selected: ${answer.labels.join(', ')}${note}`;
	const picked = answer.labels.map((l) => `- ${l}`).join('\n');
	return `The user selected ${answer.labels.length} of the options:\n${picked}${note}`;
}
