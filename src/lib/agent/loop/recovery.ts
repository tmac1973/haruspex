/**
 * The no-tool-call recovery guards: a response cut off at the token limit, a
 * malformed or refused tool call, degraded output, narration instead of a
 * call, and a file write that was described but never made. Each returns an
 * outcome to short-circuit the iteration, or null to defer to the next.
 */

import { ApiError, type ChatMessage, type ChatCompletionResponse } from '#lib/api.ts';
import { TOKEN_BYTES_RATIO } from '#lib/agent/context-budget.ts';
import { stripThinkBlocks, stripToolCallArtifacts } from '#lib/markdown.ts';
import { logDebug } from '#lib/debug-log.ts';
import { MAX_TRUNCATION_RETRIES, NudgeState, automaticCheck } from './nudges';
import type { IterationOutcome, LoopContext, LoopState } from './context';
import { hasNonThinkingContent, looksLikeClarifyingQuestion } from './heuristics';

/**
 * Echo the model's last assistant content back into `messages` and append a
 * user `nudge`, returning the `'continue'` outcome. Shared by the no-tool-call
 * recovery guards so they push the assistant/user pair the same way. Pass
 * `stripArtifacts` for the malformed-tool-call case (strips stray `<tool_call>`
 * fragments from the echoed content), and `stripThinking` when the echo exists
 * to be re-read by the model rather than shown to the user.
 */
export function pushNudge(
	messages: ChatMessage[],
	response: ChatCompletionResponse,
	nudge: string,
	stripArtifacts = false,
	stripThinking = false
): IterationOutcome {
	let content = response.content ?? '';
	if (stripArtifacts) content = stripToolCallArtifacts(content);
	// `stripThinking` is for echoes that will be re-sent to the model. Reasoning
	// travels to the chat template in its own field, so leaving `<think>` tags in
	// the content would render a second, nested block inside the template's own.
	if (stripThinking) content = stripThinkBlocks(content).trimStart();
	messages.push({ role: 'assistant', content });
	// "Continue." is joined onto the text it continues; the note would only
	// invite a preamble there.
	messages.push({ role: 'user', content: nudge === CONTINUE ? nudge : automaticCheck(nudge) });
	return 'continue';
}

/** The bare continuation nudge for a response cut off at the token limit. */
const CONTINUE = 'Continue.';

/**
 * Max-tokens truncation: the model was cut off mid-response, so continue the
 * loop to let it finish instead of throwing the work away. Precondition:
 * caller has already established `toolCalls.length === 0`.
 *
 * This used to require `state.usedTools`, which made it unreachable on the
 * first iteration — the case it is most needed for. A heavy reasoner asked for
 * a large one-shot answer overruns the ceiling *before* it ever calls a tool;
 * every other guard then declined it too, and the turn fell through to final
 * synthesis with `ctx.messages` unmutated. The model re-derived the whole
 * answer from an identical prompt (confirmed in a llama.cpp trace: same
 * prompt length, `sim_best = 1.000`), having burned 16K tokens and four
 * minutes on reasoning nobody kept.
 *
 * Two shapes, because they need opposite handling:
 *
 *  - **Cut off mid-answer** — there is real content past the reasoning. Echo
 *    it back and say "Continue.", the original behaviour. `<think>` blocks are
 *    stripped from the echo: the model's reasoning reaches the template through
 *    `reasoning_content`, not through content, so re-sending it as literal tags
 *    would nest a second `<think>` inside the one the template already emits.
 *
 *  - **Cut off still reasoning** — no answer content exists, so there is
 *    nothing coherent to continue from. Echoing a half-finished thought is
 *    worse than useless; ask for the answer directly instead. Bounded, since
 *    a model that overruns on the retry too must reach the error path rather
 *    than eat the iteration budget in silence.
 */
export function tryContinueOnLength(
	ctx: LoopContext,
	state: LoopState,
	nudges: NudgeState,
	response: ChatCompletionResponse,
	iteration: number
): IterationOutcome | null {
	if (response.finish_reason !== 'length') return null;

	// Cut off with an answer already in flight: resume it.
	if (state.usedTools || hasNonThinkingContent(response.content)) {
		logDebug('agent', `iteration ${iteration} branch=continue-on-length nudge`, {
			usedTools: state.usedTools
		});
		return pushNudge(ctx.messages, response, CONTINUE, false, true);
	}

	// Cut off while still reasoning, with no answer to resume.
	if (!nudges.needsLengthContinueRetry()) {
		logDebug('agent', `iteration ${iteration} branch=continue-on-length exhausted`, {
			retries: nudges.lengthContinueRetryCount
		});
		return null;
	}
	nudges.consumeLengthContinueRetry();
	logDebug('agent', `iteration ${iteration} branch=reasoning-overrun nudge`, {
		retry: nudges.lengthContinueRetryCount
	});
	// No assistant echo: the response was entirely reasoning, and the stripped
	// content would be an empty message.
	ctx.messages.push({
		role: 'user',
		content: automaticCheck(
			`Your previous response was cut off at the ${ctx.maxResponseTokens}-token ` +
				`limit while you were still thinking, so none of it reached the user. Answer ` +
				`now: keep your reasoning short and spend the response on the answer itself. ` +
				`If the full answer will not fit in one response, say so first and give the ` +
				`most important part.`
		)
	});
	return 'continue';
}

/**
 * Malformed tool_call recovery: even with a clean `stop` finish reason, the
 * model can emit a `<tool_call>` XML fragment in its chat content that fails
 * to parse — usually broken JSON arguments or a missing closing tag.
 */
export function tryMalformedToolCall(
	ctx: LoopContext,
	state: LoopState,
	response: ChatCompletionResponse,
	iteration: number
): IterationOutcome | null {
	if (
		state.usedTools &&
		response.content &&
		(/<tool_call>/.test(response.content) || /<function=/.test(response.content))
	) {
		logDebug('agent', `iteration ${iteration} branch=malformed-tool-call recovery`, {
			rawContent: response.content
		});
		return pushNudge(
			ctx.messages,
			response,
			'Your previous message contained a malformed or incomplete tool call — ' +
				"I couldn't parse it. If you meant to call a tool, retry with valid JSON " +
				'arguments and a properly closed <tool_call>...</tool_call> block. If you ' +
				'meant to write a final answer, write it as plain prose without any ' +
				'<tool_call> tags.',
			true
		);
	}
	return null;
}

/**
 * Detect degraded model output: after using tools, smaller models sometimes
 * emit a bare URL or a naked tool-name fragment as their "answer" instead of
 * either a structured tool_call or real prose. Break so the caller can
 * recover gracefully.
 */
export function tryDegradedOutput(
	state: LoopState,
	response: ChatCompletionResponse,
	iteration: number
): IterationOutcome | null {
	if (!state.usedTools) return null;
	const raw = (response.content || '').trim();
	const isBareUrl = /^https?:\/\/\S+$/.test(raw);
	const looksLikeNakedToolCall = /^(fetch_url|web_search|research_url|fs_[a-z_]+)\s*[:=(]/.test(
		raw
	);
	if (raw.length > 0 && (isBareUrl || looksLikeNakedToolCall)) {
		logDebug('agent', `iteration ${iteration} branch=degraded-output break`, {
			raw,
			isBareUrl,
			looksLikeNakedToolCall
		});
		return 'break';
	}
	return null;
}

/**
 * Narrate-recovery: a prior iteration pushed a nudge that demanded a tool
 * call. The model came back with text but no tool_calls — the classic
 * "describe the plan instead of executing it" failure on smaller models.
 * Force action before any final-synthesis path that would otherwise commit
 * the narration as the final answer.
 */
export function tryNarrateRecovery(
	ctx: LoopContext,
	nudges: NudgeState,
	response: ChatCompletionResponse,
	iteration: number
): IterationOutcome | null {
	if (nudges.needsNarrateRecovery() && !looksLikeClarifyingQuestion(response.content || '')) {
		nudges.consumeNarrateRecovery();
		logDebug('agent', `iteration ${iteration} branch=narrate-recovery`, {
			assistantContent: response.content
		});
		return pushNudge(
			ctx.messages,
			response,
			'STOP. Your previous response described what you would do next but did not ' +
				'actually emit a tool_calls block. Do not reply with more text explaining ' +
				'your plan — your NEXT output must be the tool_calls block that performs ' +
				'the action you just described.'
		);
	}
	return null;
}

/**
 * A tool call was refused — truncated mid-generation, or ambiguous. Ask the
 * model to re-emit it whole while there is retry budget left; when that runs
 * out, end the turn with an error naming the ceiling that caused it.
 *
 * Returning null is not an option here: falling through to the no-tool-calls
 * chain would treat a refused write as the turn's prose answer, which is the
 * silent half-success this guard exists to prevent.
 */
export function handleRejectedToolCall(
	ctx: LoopContext,
	nudges: NudgeState,
	response: ChatCompletionResponse,
	reason: string,
	iteration: number
): IterationOutcome {
	if (nudges.needsTruncationRetry()) {
		nudges.consumeTruncationRetry();
		logDebug('agent', `iteration ${iteration} branch=tool-call-rejected retry`, {
			reason,
			retry: nudges.truncationRetryCount,
			finish_reason: response.finish_reason
		});
		return pushNudge(
			ctx.messages,
			response,
			`Your last tool call was not run: ${reason}. Nothing was written and no ` +
				`action was taken. Emit the call again as a single complete tool_calls ` +
				`block, with the whole value of each argument present — do not split an ` +
				`argument across repeated parameters, and do not describe the call in ` +
				`prose.\n\n` +
				`If the content is too long to fit in one response, do NOT send it in ` +
				`pieces — a second write to the same path replaces the first rather than ` +
				`appending, so chunking loses everything but the last chunk. Instead:\n` +
				`- To change part of an existing file, use fs_edit_text with a targeted ` +
				`old_str/new_str. It never requires emitting the whole file, so it works ` +
				`at any file size.\n` +
				`- To create a new file, write less content, or split the material across ` +
				`separate files with different paths.`,
			true
		);
	}

	logDebug('agent', `iteration ${iteration} branch=tool-call-rejected exhausted`, {
		reason,
		finish_reason: response.finish_reason
	});
	ctx.options.onComplete();
	const settingLabel = ctx.expectsFileOutput
		? 'Max response tokens (file writes)'
		: 'Max response tokens';
	ctx.options.onError(
		new ApiError(
			`The model's tool call was cut off before it finished (${reason}), and it ` +
				`could not re-send it within ${MAX_TRUNCATION_RETRIES} attempts. Nothing ` +
				`was written — no file was created or partially overwritten. The response ` +
				`hit its ${ctx.maxResponseTokens}-token ceiling, which is roughly ` +
				`${Math.round((ctx.maxResponseTokens * TOKEN_BYTES_RATIO) / 1024)} KB of ` +
				`content before the model's reasoning is subtracted. Raise Settings → ` +
				`Agent → Response Length → ${settingLabel}, or ask for a smaller piece of ` +
				`work. Note that editing an existing file (fs_edit_text) has no such limit ` +
				`— only rewriting one whole does.`
		)
	);
	return 'complete';
}

/** File-write hallucination recovery. */
export function tryFileWriteRecovery(
	ctx: LoopContext,
	nudges: NudgeState,
	response: ChatCompletionResponse,
	iteration: number
): IterationOutcome | null {
	if (
		nudges.needsFileWriteNudge(ctx.expectsFileOutput) &&
		!looksLikeClarifyingQuestion(response.content || '')
	) {
		nudges.consumeFileWriteNudge();
		logDebug(
			'agent',
			`iteration ${iteration} branch=file-write-hallucination retry ${nudges.fileWriteRetryCount}`,
			{
				assistantContent: response.content
			}
		);
		nudges.armNarrateRecovery();
		return pushNudge(
			ctx.messages,
			response,
			'You have not emitted an fs_write_* tool call this turn, so nothing has been ' +
				'written or changed. If the file needs writing or changing, emit that call ' +
				'now — fs_write_text for markdown or plain text, or fs_write_pdf / ' +
				'fs_write_docx / fs_write_xlsx for a binary document — with the complete ' +
				'content as the `content` argument and a short relative path, as a ' +
				'tool_calls block rather than a description of one. If the file is already ' +
				'correct and genuinely needs no change, say so directly instead of ' +
				'describing a write you did not make.'
		);
	}
	return null;
}
