/**
 * The terminal no-tool-call handler: the research nudges, steering, the
 * forced final tool, then committing or re-streaming the answer.
 */

import { ResponseCutOffError, messageText, type ChatCompletionResponse } from '#lib/api.ts';
import type { getChatTemplateKwargs, getSamplingParams } from '#lib/stores/settings.ts';
import { logDebug } from '#lib/debug-log.ts';
import { NudgeState } from './nudges';
import type { IterationOutcome, LoopContext, LoopState } from './context';
import {
	diversityNudgePrompt,
	hasNonThinkingContent,
	looksLikeImageOnlyRequest,
	outOfTokensMessage,
	phantomImageNudgePrompt,
	researchNudgePrompt,
	wroteRemoteImageMarkdown
} from './heuristics';
import { streamFinalSynthesis } from './modelCall';
import { forceFinalToolAlreadyCalled, forceFinalToolCall } from './forcedFinal';
import { pushNudge } from './recovery';
import { continueForSteering } from './steeringQueue';

/**
 * Terminal no-tool-call handler: after the recovery guards have all
 * deferred, either nudge for source diversity, commit the clean non-stream
 * answer directly, or re-stream the final synthesis. Always returns a
 * terminal outcome.
 */
export async function finalizeNoToolCalls(
	ctx: LoopContext,
	state: LoopState,
	nudges: NudgeState,
	response: ChatCompletionResponse,
	sampling: ReturnType<typeof getSamplingParams>,
	templateKwargs: ReturnType<typeof getChatTemplateKwargs>,
	iteration: number
): Promise<IterationOutcome> {
	const { messages, tools, options } = ctx;

	// Phantom-image gate. First, because a turn that invented its image URLs
	// has produced an answer promising pictures that cannot exist, and the
	// other gates would let that stand.
	if (nudges.needsPhantomImageNudge(wroteRemoteImageMarkdown(response.content))) {
		nudges.consumePhantomImageNudge();
		logDebug('agent', `iteration ${iteration} branch=phantom-image-nudge`);
		nudges.armNarrateRecovery();
		return pushNudge(messages, response, phantomImageNudgePrompt());
	}

	// Research gate. Checked before the diversity gate because a turn that
	// only grabbed a picture has not researched at all, which is the more
	// basic failure of the two.
	const lastUserText = messageText(
		[...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
	);
	if (nudges.needsResearchNudge(state.usedTools, looksLikeImageOnlyRequest(lastUserText))) {
		nudges.consumeResearchNudge();
		logDebug('agent', `iteration ${iteration} branch=research-nudge`);
		nudges.armNarrateRecovery();
		return pushNudge(messages, response, researchNudgePrompt());
	}

	// Diversity gate.
	if (nudges.needsDiversityNudge(state.usedTools)) {
		const fetchedCount = nudges.consumeDiversityNudge();
		logDebug('agent', `iteration ${iteration} branch=diversity-nudge`, {
			fetchedCount
		});
		nudges.armNarrateRecovery();
		return pushNudge(messages, response, diversityNudgePrompt(fetchedCount));
	}

	const steered = continueForSteering(ctx, state, response, iteration);
	if (steered) return steered;

	// Audit-style turns: the model is trying to answer in prose, but only a
	// forced-tool call carries a usable result. Pin the tool instead of
	// committing the prose (which the caller would discard).
	if (ctx.forceFinalTool && !forceFinalToolAlreadyCalled(ctx)) {
		await forceFinalToolCall(ctx, nudges);
		return 'complete';
	}

	// If this iteration's non-streaming check call already came back with a
	// clean, substantive answer, surface it directly through the stream
	// callbacks and skip the redundant re-stream.
	if (response.finish_reason === 'stop' && hasNonThinkingContent(response.content)) {
		const content = response.content ?? '';
		logDebug(
			'agent',
			`iteration ${iteration} branch=final-synthesis (commit non-stream response, skip re-stream)`,
			{ contentLen: content.length, usedTools: state.usedTools }
		);
		options.onStreamChunk({
			delta: { content },
			finish_reason: 'stop'
		});
		options.onComplete();
		return 'complete';
	}

	// Re-stream the final answer. After tools, drop the tool list (the model
	// is answering, not calling) and tailor the out-of-tokens hint; the
	// no-tools path keeps tools available in case it still wants one.
	const postTools = state.usedTools;
	if (postTools) {
		logDebug('agent', `iteration ${iteration} branch=final-synthesis (post-tools re-stream)`, {
			reason:
				response.finish_reason === 'length'
					? 'non-stream truncated (length)'
					: 'non-stream had no usable content'
		});
	} else {
		logDebug('agent', `iteration ${iteration} branch=final-synthesis (no-tools)`);
	}
	const { lastFinish, totalChunks, totalContent } = await streamFinalSynthesis(
		ctx,
		postTools ? undefined : tools,
		sampling,
		templateKwargs
	);
	logDebug('agent', `final synthesis (${postTools ? 'post-tools' : 'no-tools'}) ended`, {
		chunks: totalChunks,
		contentLen: totalContent,
		lastFinish
	});
	options.onComplete();
	if (lastFinish === 'length') {
		options.onError(new ResponseCutOffError(outOfTokensMessage(ctx, postTools)));
	}
	return 'complete';
}
