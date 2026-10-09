/**
 * One iteration of the agent loop. Keeps the top-level `runAgentLoop` in
 * loop.ts down to a driver that just runs the for-loop and dispatches on
 * each iteration's outcome. The pieces it calls live beside it:
 *
 *   - `context.ts`       LoopContext / LoopState, built once per turn
 *   - `modelCall.ts`     guarded, streamed and final-synthesis model calls
 *   - `recovery.ts`      the no-tool-call recovery guards
 *   - `finalAnswer.ts`   the terminal no-tool-call handler
 *   - `forcedFinal.ts`   the forced final tool and the max-iterations wrap-up
 *   - `toolCalls.ts`     running a round's tool calls
 *   - `steeringQueue.ts` delivering queued steering
 *   - `heuristics.ts`    pure reads of the conversation and nudge texts
 *
 * Cycle note: none of these import loop.ts at runtime. Types from loop.ts
 * come in via `import type` so there's no circular runtime dependency.
 */

import {
	getChatTemplateKwargs,
	getSamplingParams,
	getOpenRouterReasoningParam
} from '#lib/stores/settings.ts';
import { logDebug } from '#lib/debug-log.ts';
import { NudgeState } from './nudges';
import type { IterationOutcome, LoopContext, LoopState } from './context';
import { injectPendingImages, runModelCall, samplingOptionsFor } from './modelCall';
import {
	handleRejectedToolCall,
	tryContinueOnLength,
	tryDegradedOutput,
	tryFileWriteRecovery,
	tryMalformedToolCall,
	tryNarrateRecovery
} from './recovery';
import { finalizeNoToolCalls } from './finalAnswer';
import { executeToolCalls } from './toolCalls';
import { deliverSteering } from './steeringQueue';

export {
	buildLoopContext,
	contextResponseFloor,
	inLoopTrimBudget,
	LoopState,
	type IterationOutcome,
	type LoopContext
} from './context';
export { isCodeContext, looksLikeImageOnlyRequest, wroteRemoteImageMarkdown } from './heuristics';
export { runMaxIterationsFinalSynthesis } from './forcedFinal';

/**
 * One iteration of the agent loop. Returns:
 *   - 'continue': push messages, take another iteration.
 *   - 'break':    exit the loop and run the max-iterations handler.
 *   - 'complete': streamed the final answer; runAgentLoop should return.
 *
 * Pre-conditions on entry: caller has already checked the abort signal.
 */
export async function runIteration(
	ctx: LoopContext,
	state: LoopState,
	nudges: NudgeState,
	iteration: number
): Promise<IterationOutcome> {
	const { messages } = ctx;
	logDebug('agent', `iteration ${iteration} start`, { messageCount: messages.length });

	// Reset per-iteration; only the tool path below can set it true. Read by
	// the driver on a 'continue' outcome to decide whether this turn counts
	// against the iteration budget.
	state.allWebReadsBlocked = false;
	state.steeringContinue = false;

	// If images were loaded on the previous iteration, attach them to the
	// most recent user message before sending. This is how multimodal
	// requests reach the vision model.
	if (ctx.pendingImages.length > 0) {
		injectPendingImages(messages, ctx.pendingImages);
		ctx.pendingImages.length = 0;
	}

	const sampling = getSamplingParams(ctx.descriptor, samplingOptionsFor(ctx, messages));
	const templateKwargs = getChatTemplateKwargs(
		ctx.descriptor,
		ctx.thinkingEnabled,
		ctx.reasoningEffort
	);
	const reasoning =
		getOpenRouterReasoningParam(ctx.descriptor, ctx.thinkingEnabled, ctx.reasoningEffort) ??
		undefined;
	const { response, toolCalls, rejection } = await runModelCall(
		ctx,
		sampling,
		templateKwargs,
		reasoning,
		iteration
	);

	// A refused call is handled before the no-tool-calls chain: the model DID
	// attempt a call, so treating this as prose would let a truncated write
	// pass silently as the turn's answer.
	if (rejection) {
		const rejected = handleRejectedToolCall(ctx, nudges, response, rejection, iteration);
		if (rejected) return rejected;
	}

	// No tool calls: run the recovery-guard chain in priority order, then
	// fall through to the terminal no-tool-call handler. Each guard checks
	// its own precondition and returns an outcome to short-circuit, or null
	// to defer to the next. `??` preserves the original sequential-if order.
	if (toolCalls.length === 0) {
		const recovered =
			tryContinueOnLength(ctx, state, nudges, response, iteration) ??
			tryMalformedToolCall(ctx, state, response, iteration) ??
			tryDegradedOutput(state, response, iteration) ??
			tryNarrateRecovery(ctx, nudges, response, iteration) ??
			tryFileWriteRecovery(ctx, nudges, response, iteration);
		if (recovered) return recovered;
		return await finalizeNoToolCalls(
			ctx,
			state,
			nudges,
			response,
			sampling,
			templateKwargs,
			iteration
		);
	}

	state.usedTools = true;
	// Model emitted real tool_calls — clear any pending narrate-recovery
	// so we don't fire it spuriously on a later no-tool-calls iteration.
	nudges.consumeNarrateRecovery();
	const { allWebReadsBlocked } = await executeToolCalls(ctx, nudges, toolCalls, response);
	state.allWebReadsBlocked = allWebReadsBlocked;
	// The forced-final tool IS the turn's terminus: its arguments are the
	// result, and the contract every caller states is "call it exactly once,
	// at the end". End the turn the moment the model calls it — without this,
	// nothing stops the model after submitting, and a model that doesn't fall
	// silent on its own keeps working and re-submitting (observed: ~20
	// submit_iteration_result calls in one coding iteration before the user
	// cancelled the run).
	//
	// ONLY when it is the response's sole call, though. A model can bundle the
	// forced tool speculatively with other work — a real preflight bundled
	// ask_user_question with a submit_preflight whose blocker text was its own
	// to-do note ("need to present commands to user for confirmation"); the
	// user answered the question, the turn ended on the speculative submit,
	// and the run failed on a verdict the model never meant. Bundled calls all
	// execute, then the turn continues so the model can act on their results;
	// the runaway case still dies on its first solo submit.
	if (ctx.forceFinalTool && toolCalls.every((c) => c.name === ctx.forceFinalTool)) {
		ctx.options.onComplete();
		return 'complete';
	}
	// Break out of a no-progress loop (same command re-run repeatedly) instead
	// of cycling to the iteration cap; the final-synthesis path then wraps up.
	if (nudges.shouldStopForCommandRepeat()) {
		logDebug('agent', 'branch=run-command-repeat stop', {});
		return 'break';
	}
	// The iteration boundary: tool results are in, the next model call hasn't
	// gone out. Checked after the two terminal branches above so a turn that is
	// ending anyway hands queued texts back rather than swallowing them.
	deliverSteering(ctx, iteration);
	return 'continue';
}
