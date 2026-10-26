/**
 * `haruspex_feedback`: the model reporting where Haruspex's own tools got in
 * its way, for whoever is improving Haruspex. Offered only while Settings →
 * Feedback → Model feedback on tools is on (see the registry), in every mode
 * and in jobs, never to a remote guest.
 *
 * The guidance lives in the description, not a system prompt: jobs and the
 * Code tab build their own prompts, and the description reaches all of them.
 * The report is written with the turn's last few tool calls attached (see
 * `harnessFeedback/report.ts`), so it can be checked against what happened.
 */

import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import {
	FEEDBACK_KINDS,
	FEEDBACK_TOOL,
	modelName,
	recordFeedback,
	traceFromMessages,
	type FeedbackEntry,
	type FeedbackKind
} from '#lib/harnessFeedback/report.ts';
import { errMessage } from '#lib/utils/error.ts';

/** Reports one turn may make. More than this is the tool getting in the way. */
export const MAX_REPORTS_PER_TURN = 3;

function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

function turnMode(ctx: ToolContext): string {
	if (ctx.subtask) return 'subtask';
	if (ctx.jobSubtasks) return 'job';
	if (ctx.codeMode) return ctx.shellMode ? 'shell-code' : 'code';
	if (ctx.shellMode) return 'shell';
	return 'chat';
}

function turnSource(ctx: ToolContext): string | undefined {
	if (ctx.feedback) return ctx.feedback.source;
	if (ctx.codeSessionId) return `code session ${ctx.codeSessionId}`;
	if (ctx.conversationId) return `conversation ${ctx.conversationId}`;
	return undefined;
}

/** The report as it is written: the model's words, and what Haruspex knows of the turn. */
function feedbackEntry(
	args: Record<string, unknown>,
	ctx: ToolContext,
	what: string,
	expected: string
): FeedbackEntry {
	const tool = str(args.tool) || 'unknown';
	const kind = FEEDBACK_KINDS.includes(args.kind as FeedbackKind)
		? (args.kind as FeedbackKind)
		: 'other';
	const suggestion = str(args.suggestion);
	return {
		origin: ctx.feedback?.origin ?? 'tool',
		tool,
		kind,
		what_happened: what,
		expected,
		...(suggestion ? { suggestion } : {}),
		mode: turnMode(ctx),
		source: turnSource(ctx),
		model: modelName(ctx.backend),
		trace: ctx.feedback?.trace?.() ?? traceFromMessages(ctx.transcript?.() ?? [], 5, tool)
	};
}

registerTool({
	category: 'harness-feedback',
	schema: {
		type: 'function',
		function: {
			name: FEEDBACK_TOOL,
			description:
				"Report a problem with Haruspex's own tools to its developers: a tool that failed when it shouldn't have, a result that misled you, an error that didn't say what to do, a capability you needed and didn't have, a schema that was hard to use, or guide text that was wrong. One report per distinct problem, then carry on with the task. Not for the user's task, a website or file that is simply wrong, or your own mistakes. The user does not see these reports; never mention them.",
			parameters: {
				type: 'object',
				properties: {
					tool: {
						type: 'string',
						description:
							'The tool or capability concerned, e.g. fs_edit_text, or "none" for a missing one.'
					},
					kind: { type: 'string', enum: [...FEEDBACK_KINDS] },
					what_happened: {
						type: 'string',
						description: 'What you did and what came back. Be concrete.'
					},
					expected: { type: 'string', description: 'What you expected or needed instead.' },
					suggestion: {
						type: 'string',
						description: 'Optional: how the tool could change to avoid this.'
					}
				},
				required: ['tool', 'kind', 'what_happened', 'expected']
			}
		}
	},
	displayLabel: (args) => str(args.tool) || 'feedback',
	async execute(args, ctx) {
		const what = str(args.what_happened);
		const expected = str(args.expected);
		if (!what || !expected) {
			return toolResult(toolError('what_happened and expected are both needed.'));
		}
		const counter = ctx.feedbackThisTurn ?? { count: 0 };
		if (counter.count >= MAX_REPORTS_PER_TURN) {
			return toolResult(
				toolError('Enough reports for this turn. Carry on with the task without reporting.')
			);
		}
		counter.count++;
		try {
			await recordFeedback(feedbackEntry(args, ctx, what, expected));
		} catch (e) {
			// Not the model's problem to solve: say so and let it get on.
			console.warn('haruspex_feedback: could not save a report', errMessage(e));
			return toolResult('Not recorded (it could not be saved). Carry on with the task.');
		}
		return toolResult('Recorded. Carry on with the task.');
	}
});
