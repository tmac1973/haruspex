/**
 * Running one iteration's tool calls and appending their results.
 */

import type { ChatCompletionResponse } from '#lib/api.ts';
import { toolRoundText } from '#lib/agent/textToolCalls.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import { coerceCallArguments, executeTool } from '#lib/agent/tools/index.ts';
import { isFetchFailureResult, isToolErrorResult } from '#lib/agent/tools/_helpers.ts';
import { isVerbosePayloads, logDebug } from '#lib/debug-log.ts';
import { NudgeState } from './nudges';
import { planToolBatches, runToolBatch, toolCallConcurrency } from './parallelTools';
import { createSlotLender, laneConcurrency } from '#lib/agent/inferenceQueue.svelte.ts';
import type { LoopContext } from './context';
import { raceWithAbort } from './modelCall';

/**
 * Execute the model's tool calls: append the assistant tool_calls message,
 * then run each tool (raced against the abort signal), stream its result back
 * through the callbacks, update nudge bookkeeping, and append the tool result
 * message. Consecutive read-only calls may run side by side (see
 * `parallelTools`); their results are still appended in call order. Throws
 * AbortError if the signal fires mid-tool.
 *
 * Returns `allWebReadsBlocked: true` when EVERY call this iteration was a web
 * read (fetch_url / research_url / web_search) that came back externally
 * blocked — a 403 / bot-detection / paywall page, or a rate-limited search.
 * The driver uses this to grant a bounded free retry: a page the model could
 * not have avoided failing on shouldn't consume the turn budget and force an
 * incomplete answer.
 */
export async function executeToolCalls(
	ctx: LoopContext,
	nudges: NudgeState,
	toolCalls: ResolvedToolCall[],
	response?: ChatCompletionResponse
): Promise<{ allWebReadsBlocked: boolean }> {
	const { messages, signal, options } = ctx;
	// Count calls that were web reads blocked by an external resource. When
	// this equals toolCalls.length, the whole iteration was wasted on blocks.
	let blockedWebReads = 0;

	// Append assistant message with tool calls. Its text is dropped (the model
	// regenerates its answer after seeing tool results) unless the caller
	// streamed the round: then the user has read it, and it stays part of the
	// conversation, minus reasoning and any calls written as text.
	// For OpenRouter reasoning models, echo `reasoning_details` back
	// unmodified so multi-turn reasoning quality is preserved across the
	// tool loop (OpenRouter docs: reasoning_details must be threaded verbatim).
	messages.push({
		role: 'assistant',
		content: options.streamToolRounds ? toolRoundText(response?.content) : '',
		tool_calls: toolCalls.map((tc) => ({
			id: tc.id,
			type: 'function' as const,
			function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
		})),
		...(response?.reasoning_details?.length
			? { reasoning_details: response.reasoning_details }
			: {})
	});

	// Read-only calls run side by side when the lane takes parallel requests;
	// everything else, and every call on a serialized lane, one at a time.
	const concurrency = toolCallConcurrency(laneConcurrency(ctx.backend ?? undefined));
	const runInSlot =
		concurrency > 1 ? createSlotLender({ backend: ctx.backend ?? undefined, signal }) : undefined;

	const runCall = async (call: ResolvedToolCall) => {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

		// Arguments carry email bodies, file contents and shell commands, and this
		// buffer goes into the feedback bundle: the keys are enough by default.
		logDebug('agent', `tool start: ${call.name}`, {
			args: isVerbosePayloads() ? call.arguments : Object.keys(call.arguments ?? {})
		});
		// Coerced, as the executor will see them. A stage that captures a
		// structured answer here read the model's raw arguments: an `entries`
		// array sent as a JSON string was walked character by character, and
		// a night's asset spec was rejected as dozens of "entries with no id".
		options.onToolStart({ ...call, arguments: coerceCallArguments(call.name, call.arguments) });
		// Race the tool call against the abort signal. Most tools dispatch
		// to Tauri commands or fetch and don't honor signal themselves, so
		// without this race a cancel mid-tool waits for the tool to finish
		// before taking effect — which from the user's perspective looks
		// like the cancel button is broken. The orphaned Rust work
		// completes silently; its result is discarded.
		const output = await raceWithAbort(
			executeTool(call.name, call.arguments, {
				workingDir: ctx.workingDir,
				signal,
				pendingImages: ctx.pendingImages,
				visionSupported: ctx.options.visionSupported ?? true,
				deepResearch: ctx.deepResearch,
				shellMode: ctx.shellMode,
				codeMode: ctx.codeMode,
				codeAutoApprove: ctx.codeAutoApprove,
				interactive: ctx.interactive,
				conversationId: ctx.conversationId,
				backend: ctx.backend,
				runInSlot,
				askUser: ctx.askUser,
				skills: ctx.skills,
				writeRoot: ctx.writeRoot,
				shellCwd: ctx.shellCwd,
				shellSessionId: ctx.shellSessionId,
				codeSessionId: ctx.codeSessionId,
				requester: ctx.requester,
				codeReadOnly: ctx.codeReadOnly,
				codeWriteGuard: ctx.codeWriteGuard,
				wslDistro: ctx.wslDistro,
				filesWrittenThisTurn: ctx.filesWrittenThisTurn,
				filesRewritableThisTurn: ctx.filesRewritableThisTurn,
				onProgress: (status: string) => options.onToolProgress?.(call, status)
			}),
			signal
		);
		logDebug('agent', `tool end: ${call.name}`, {
			resultLen: output.result.length,
			resultPreview: output.result.slice(0, 1000),
			hasThumbnail: !!output.thumbDataUrl,
			artifactCount: output.artifacts?.length ?? 0
		});
		options.onToolEnd(
			call,
			output.result,
			output.thumbDataUrl,
			output.artifacts,
			output.lintIssues,
			output.heroImage,
			output.fileDiff
		);
		return output;
	};

	// In call order, whatever order the calls finished in.
	const recordResult = (call: ResolvedToolCall, output: Awaited<ReturnType<typeof runCall>>) => {
		// Track successful file-write calls so the hallucination check
		// knows a real write happened.
		if (call.name.startsWith('fs_write_') && !output.result.includes('"error"')) {
			nudges.markFileWritten();
		}

		// Prepend a "[Source: <url>]" header to successful page fetches.
		let toolContent = output.result;
		if (call.name === 'image_search') {
			nudges.markImageSearchUsed();
		}
		if (call.name === 'web_search') {
			nudges.markWebSearchUsed();
			// A search that errored out (rate-limited engines, bot gate) left the
			// model with nothing to work with — count it as an external block.
			if (isToolErrorResult(toolContent)) blockedWebReads++;
		}
		if (call.name === 'fetch_url' || call.name === 'research_url') {
			const url = call.arguments.url as string | undefined;
			if (isFetchFailureResult(toolContent)) {
				// 403 / bot detection / paywall — the page is unreadable through
				// no fault of the model. Don't let it cost the turn budget.
				blockedWebReads++;
			} else if (url) {
				nudges.recordFetchedUrl(url);
				// The hero image goes on its own line beside the Source header,
				// and the line is omitted entirely when the page declared none —
				// an empty field is something a small model will try to fill in.
				const imageLine = output.heroImage ? `\n[Image: ${output.heroImage}]` : '';
				toolContent = `[Source: ${url}]${imageLine}\n\n${toolContent}`;
			}
		}

		if (call.name === 'run_python') {
			toolContent = nudges.maybeAppendRunPythonHint(toolContent);
		}

		// No-progress guard: re-running the identical command (a GUI/no-output
		// program looks like "it failed" to the model) gets a hint, then a
		// hard stop. Any other tool counts as progress and resets the streak.
		if (call.name === 'run_command') {
			toolContent = nudges.maybeAppendRunCommandHint(
				(call.arguments.command as string) ?? '',
				toolContent
			);
		} else {
			nudges.noteNonRunCommandTool();
		}

		messages.push({
			role: 'tool',
			tool_call_id: call.id,
			content: toolContent
		});
	};

	for (const batch of planToolBatches(toolCalls)) {
		await runToolBatch(batch, concurrency, runCall, recordResult);
	}

	// Whole iteration spent on web reads that were all blocked → signal the
	// driver to grant a free retry. An empty toolCalls list never reaches here.
	return { allWebReadsBlocked: blockedWebReads === toolCalls.length };
}
