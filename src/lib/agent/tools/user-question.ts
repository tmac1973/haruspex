import { registerTool } from './registry';
import { toolResult, toolError } from './types';

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
				'Ask the user a single multiple-choice question and wait for their answer. ' +
				'Ask exactly ONE question per call. The user can always type a free-text ' +
				'answer instead of picking an option, so offer the most likely choices ' +
				'rather than trying to be exhaustive. Use this only to resolve a genuine ' +
				'decision you cannot make confidently from context — not for trivia, and ' +
				'not to confirm things the user already told you.',
			parameters: {
				type: 'object',
				properties: {
					question: { type: 'string', description: 'The question to ask the user.' },
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
						description: 'Set true if the user may pick more than one option.'
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

		// No live user to answer — fail safe instead of hanging. Phase 05 upgrades
		// this to a pause-to-needs-input signal for guided-planning jobs.
		if (!ctx.interactive) {
			return toolResult(
				toolError('No interactive user is available to answer questions in this context.')
			);
		}

		const { askUserQuestion } = await import('$lib/stores/userQuestion.svelte');
		const answer = await askUserQuestion({
			question,
			options,
			allowMultiple: args.allow_multiple === true
		});

		const text =
			answer.kind === 'freeText'
				? `The user wrote a custom answer: ${answer.text}`
				: `The user selected: ${answer.labels.join(', ')}`;
		return toolResult(text);
	}
});
