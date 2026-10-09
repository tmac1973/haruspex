/**
 * Ending a turn without another tool round: the forced final tool call an
 * audit-style turn must finish with, and the final synthesis after the
 * iteration cap.
 */

import { ResponseCutOffError, type ChatCompletionResponse } from '#lib/api.ts';
import { resolveToolCalls } from '#lib/agent/parser.ts';
import {
	getChatTemplateKwargs,
	getSamplingParams,
	getOpenRouterReasoningParam
} from '#lib/stores/settings.ts';
import { isAbortError } from '#lib/utils/error.ts';
import { logDebug } from '#lib/debug-log.ts';
import { NudgeState, automaticCheck } from './nudges';
import type { CompletionMeta } from '../loop';
import type { LoopContext, LoopState } from './context';
import { outOfTokensMessage } from './heuristics';
import {
	applyContextGuard,
	completionSender,
	reportCall,
	samplingOptionsFor,
	streamFinalSynthesis
} from './modelCall';
import { executeToolCalls } from './toolCalls';

/**
 * True if the forced-final tool has already been called this turn (the
 * model emitted it on its own during a normal iteration). Scans the
 * accumulated assistant tool_calls so the terminal handlers don't force a
 * redundant second call.
 */
export function forceFinalToolAlreadyCalled(ctx: LoopContext): boolean {
	const name = ctx.forceFinalTool;
	if (!name) return false;
	return ctx.messages.some(
		(m) => m.role === 'assistant' && m.tool_calls?.some((tc) => tc.function?.name === name)
	);
}

/**
 * Force the turn to end with a `ctx.forceFinalTool` call. Used when an
 * audit sample/verify turn is wrapping up without having produced its
 * required structured output — a free-text answer would be discarded, so we
 * pin the model to the tool via `tool_choice` and dispatch the result
 * through the normal tool path (firing onToolStart/onToolEnd so the caller
 * captures the arguments). Best-effort: if the forced call fails or the
 * server returns no usable call, the turn completes empty rather than
 * throwing, matching the "model genuinely found nothing" outcome.
 */
export async function forceFinalToolCall(
	ctx: LoopContext,
	nudges: NudgeState,
	meta?: CompletionMeta
): Promise<void> {
	const name = ctx.forceFinalTool!;
	const tool = ctx.tools.find((t) => t.function.name === name);
	logDebug('agent', 'branch=force-final-tool', { tool: name, found: !!tool });

	ctx.messages.push({
		role: 'user',
		content:
			`You have finished investigating. Call the ${name} tool now with everything ` +
			`you found. Submitting partial or empty results is acceptable — do NOT reply ` +
			`with prose, and do not investigate further.`
	});

	const sampling = getSamplingParams(ctx.descriptor, samplingOptionsFor(ctx, ctx.messages));
	const templateKwargs = getChatTemplateKwargs(
		ctx.descriptor,
		ctx.thinkingEnabled,
		ctx.reasoningEffort
	);
	const reasoning =
		getOpenRouterReasoningParam(ctx.descriptor, ctx.thinkingEnabled, ctx.reasoningEffort) ??
		undefined;
	const offered = tool ? [tool] : ctx.tools;
	applyContextGuard(ctx, ctx.maxResponseTokens, offered);

	let response: ChatCompletionResponse;
	const callStartMs = Date.now();
	try {
		response = await completionSender(ctx)(
			{
				messages: ctx.messages,
				tools: offered,
				backend: ctx.backend ?? undefined,
				tool_choice: { type: 'function', function: { name } },
				...sampling,
				max_tokens: ctx.maxResponseTokens,
				chat_template_kwargs: templateKwargs,
				reasoning
			},
			ctx.signal
		);
	} catch (e) {
		if (isAbortError(e)) throw e;
		logDebug('agent', 'forced final tool call failed', { tool: name, error: String(e) });
		ctx.options.onComplete(meta);
		return;
	}

	// Reported before the early returns below: this is the ONLY model call a
	// forced-tool turn makes (it returns without reaching final synthesis), so
	// skipping it on the no-usable-call paths would leave the whole turn
	// unaccounted for — including the reasoning that produced the dud.
	if (response.usage) ctx.options.onUsageUpdate?.(response.usage);
	reportCall(ctx, {
		durationMs: Date.now() - callStartMs,
		usage: response.usage,
		text: response.content
	});

	// A rejected resolution has no usable call either — this path has no retry
	// budget, so it ends the turn the same way an empty result does.
	const resolution = resolveToolCalls(response, ctx.tools);
	const calls = resolution.kind === 'calls' ? resolution.calls.filter((c) => c.name === name) : [];
	if (calls.length === 0) {
		logDebug('agent', 'forced final tool call returned no usable call', { tool: name });
		ctx.options.onComplete(meta);
		return;
	}
	await executeToolCalls(ctx, nudges, calls, response);
	ctx.options.onComplete(meta);
}

/**
 * Final synthesis when the iteration cap was hit — push a "now answer
 * from what you have" nudge if any tool ran, then stream the answer
 * without offering tools. Called from runAgentLoop after the for-loop
 * exits without an iteration returning 'complete'.
 */
export async function runMaxIterationsFinalSynthesis(
	ctx: LoopContext,
	state: LoopState,
	nudges: NudgeState,
	stopReason: 'max_iterations' | 'forced_stop'
): Promise<void> {
	logDebug('agent', `branch=max-iterations reached`, {
		maxIterations: ctx.maxIterations,
		usedTools: state.usedTools
	});
	// Audit-style turns must finish with their structured-output tool. The
	// model spent its whole budget investigating and never submitted, so a
	// prose synthesis here would be thrown away — force the tool instead.
	if (ctx.forceFinalTool && !forceFinalToolAlreadyCalled(ctx)) {
		await forceFinalToolCall(ctx, nudges, { stopReason });
		return;
	}
	if (state.usedTools) {
		// Chat/research turns want a definitive "stop searching, answer
		// now" nudge; shell-troubleshooting turns should wrap up with
		// what they have AND tell the user what they would have looked
		// at next. The harsh prompt for chat produces a clean answer;
		// the same prompt in shell mode produces 128-char aborts.
		const finalPrompt = ctx.shellMode
			? 'Wrap up now using what you have found so far. If your investigation is incomplete, briefly say so and suggest the next command or file the user could share with you to continue.'
			: 'Now please provide your complete answer based on everything you have researched. Do not search for anything else.';
		ctx.messages.push({ role: 'user', content: automaticCheck(finalPrompt) });
	}
	// Reasoning off: the thinking happened over the whole turn, and this call
	// writes it up. With it on, a model at the end of a long research turn
	// spent most of the response cap deliberating and was cut off mid-answer
	// (run 94: 14K of 22K output tokens were reasoning).
	const sampling = getSamplingParams(ctx.descriptor, {
		...samplingOptionsFor(ctx, ctx.messages),
		thinkingEnabled: false
	});
	const templateKwargs = getChatTemplateKwargs(ctx.descriptor, false, ctx.reasoningEffort);
	const { lastFinish, totalChunks, totalContent } = await streamFinalSynthesis(
		ctx,
		undefined,
		sampling,
		templateKwargs,
		false
	);
	logDebug('agent', `final synthesis (max-iterations) ended`, {
		chunks: totalChunks,
		contentLen: totalContent,
		lastFinish
	});
	ctx.options.onComplete({ stopReason });
	if (lastFinish === 'length') {
		// Same `length` finish reason as the normal path, so the same limit is at
		// fault — the iteration cap is why the turn ended here, not why the answer
		// was cut off. Don't point at the context size for an output-cap failure.
		ctx.options.onError(
			new ResponseCutOffError(
				'Reached the iteration limit, and the final answer was then cut off too. ' +
					outOfTokensMessage(ctx, true)
			)
		);
	}
}
