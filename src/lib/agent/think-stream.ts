import type { StreamChunk } from '$lib/api';

/**
 * Fold one streaming delta into an accumulating buffer, wrapping any
 * reasoning tokens in a single `<think>…</think>` block ahead of the visible
 * content. Shared by every turn driver (chat / shell / ephemeral) so the
 * think-block bookkeeping lives in one place.
 */
export function appendStreamDelta(buf: string, delta: StreamChunk['delta']): string {
	if (delta.reasoning_content) {
		if (!buf.includes('<think>')) buf += '<think>';
		buf += delta.reasoning_content;
	}
	if (delta.content) {
		if (buf.includes('<think>') && !buf.includes('</think>')) buf += '</think>\n\n';
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
