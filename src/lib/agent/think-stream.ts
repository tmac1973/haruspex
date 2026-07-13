import type { StreamChunk } from '$lib/api';

/**
 * Per-turn memo of which think tags have already been appended, so
 * `appendStreamDelta` doesn't have to `includes()`-scan the whole
 * accumulated buffer on every delta (O(n²) over a long turn). Purely an
 * optimization: with no state passed, behavior falls back to buffer scans.
 */
export interface ThinkStreamState {
	sawThinkOpen: boolean;
	sawThinkClose: boolean;
}

export function createThinkStreamState(): ThinkStreamState {
	return { sawThinkOpen: false, sawThinkClose: false };
}

/**
 * Fold one streaming delta into an accumulating buffer, wrapping any
 * reasoning tokens in a single `<think>…</think>` block ahead of the visible
 * content. Shared by every turn driver (chat / shell / ephemeral) so the
 * think-block bookkeeping lives in one place.
 */
export function appendStreamDelta(
	buf: string,
	delta: StreamChunk['delta'],
	state?: ThinkStreamState
): string {
	// OpenRouter normalizes reasoning to `reasoning` (string) with an alias
	// `reasoning_content`; take whichever is present so the think-stream panel
	// renders for both local llama.cpp reasoning models and OpenRouter ones.
	const reasoning = delta.reasoning_content ?? delta.reasoning;
	if (reasoning) {
		if (state ? !state.sawThinkOpen : !buf.includes('<think>')) {
			buf += '<think>';
			if (state) state.sawThinkOpen = true;
		}
		buf += reasoning;
	}
	if (delta.content) {
		const open = state ? state.sawThinkOpen : buf.includes('<think>');
		const closed = state ? state.sawThinkClose : buf.includes('</think>');
		if (open && !closed) {
			buf += '</think>\n\n';
			if (state) state.sawThinkClose = true;
		}
		buf += delta.content;
	}
	return buf;
}

/**
 * True when a streaming buffer holds visible ANSWER text — not just an
 * in-progress `<think>…` reasoning block. While the model is only reasoning the
 * buffer is an unclosed `<think>…` (the closing tag is added by `appendStreamDelta`
 * once real content arrives), which renders to nothing. Callers use this to keep
 * showing the "thinking" indicator (bouncing dots) during reasoning instead of an
 * empty blinking cursor, and to switch to the streamed answer only once it exists.
 */
export function hasStreamingAnswer(buf: string): boolean {
	const withoutThink = buf
		.replace(/<think>[\s\S]*?<\/think>/g, '') // closed reasoning blocks
		.replace(/<think>[\s\S]*$/, ''); // a still-open reasoning block at the end
	return withoutThink.trim().length > 0;
}
