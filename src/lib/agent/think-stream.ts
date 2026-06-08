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
