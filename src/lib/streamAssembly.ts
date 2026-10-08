/**
 * Turning a streamed chat completion back into the response a non-streaming
 * call returns.
 *
 * The agent loop's tool rounds were non-streaming so that everything after the
 * call — `resolveToolCalls`, the nudges, the truncation guards — could read one
 * finished `ChatCompletionResponse`. A caller that opts into streaming those
 * rounds (`AgentLoopOptions.streamToolRounds`) gets the same object from here,
 * so none of that code knows the difference.
 *
 * Kept free of runtime imports so `api.ts` can share `combineReasoningAndContent`
 * with it without a cycle.
 */

import type {
	ChatCompletionResponse,
	StreamChunk,
	ToolCall,
	ToolCallDelta,
	Usage
} from '#lib/api.ts';

/**
 * Merge a model's separate `reasoning_content` and `content` into one string,
 * wrapping reasoning in a <think> block. Returns null only when both are
 * empty.
 */
export function combineReasoningAndContent(
	reasoning: string | undefined,
	content: string | null
): string | null {
	if (reasoning && content) return `<think>${reasoning}</think>\n\n${content}`;
	if (reasoning) return `<think>${reasoning}</think>`;
	return content;
}

/** A tool call as far as the stream has written it. */
export interface PartialToolCall {
	id?: string;
	name?: string;
	/** The argument JSON so far — usually not yet parseable. */
	argsSoFar: string;
}

let fallbackIdSeq = 0;

/**
 * Folds `StreamChunk`s into a `ChatCompletionResponse` shaped exactly as
 * `chatCompletion` shapes one:
 *
 *  - `content` is reasoning in `<think>` tags ahead of the answer text, or null
 *    when neither arrived;
 *  - `tool_calls` are assembled by `index` — id and name from whichever delta
 *    carries them first, argument chunks concatenated in order — and absent
 *    when the model wrote none;
 *  - `finish_reason` and `usage` are the last ones the stream reported.
 *
 * A call whose arguments were cut off (finish reason `length`) keeps its
 * partial JSON, as a non-streaming response would: refusing it is the
 * parser's job.
 */
export class StreamResponseAssembler {
	private content = '';
	private reasoning = '';
	private readonly calls = new Map<number, PartialToolCall>();
	private finishReason: string | null = null;
	private usage: Usage | undefined;

	push(chunk: StreamChunk): void {
		const { delta } = chunk;
		// Either field name, as `chatCompletion` and `appendStreamDelta` take it.
		const reasoning = delta.reasoning_content ?? delta.reasoning;
		if (reasoning) this.reasoning += reasoning;
		if (delta.content) this.content += delta.content;
		for (const tc of delta.tool_calls ?? []) this.pushCall(tc);
		if (chunk.finish_reason) this.finishReason = chunk.finish_reason;
		if (chunk.usage) this.usage = chunk.usage;
	}

	private pushCall(tc: ToolCallDelta): void {
		const call = this.calls.get(tc.index) ?? { argsSoFar: '' };
		// Some servers repeat the id and name on every delta; the first wins.
		if (tc.id && !call.id) call.id = tc.id;
		if (tc.function?.name && !call.name) call.name = tc.function.name;
		if (tc.function?.arguments) call.argsSoFar += tc.function.arguments;
		this.calls.set(tc.index, call);
	}

	/** The call at `index` as written so far, or null before it starts. */
	partial(index: number): PartialToolCall | null {
		const call = this.calls.get(index);
		return call ? { ...call } : null;
	}

	finish(): ChatCompletionResponse {
		const toolCalls: ToolCall[] = [...this.calls.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, c]) => ({
				id: c.id ?? `call_stream_${++fallbackIdSeq}`,
				type: 'function',
				function: { name: c.name ?? '', arguments: c.argsSoFar }
			}));
		return {
			content: combineReasoningAndContent(this.reasoning || undefined, this.content || null),
			tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
			finish_reason: this.finishReason ?? 'stop',
			usage: this.usage,
			// OpenRouter streams `reasoning_details` as fragments; echoing them back
			// would need merging that nobody has verified, so a streamed round
			// carries none — as a local llama-server response never does.
			reasoning_details: null
		};
	}
}
