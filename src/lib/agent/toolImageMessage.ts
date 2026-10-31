import type { ChatMessage } from '#lib/api.ts';

/** Opens the `user` message that carries a turn's tool pictures (`loop/toolImages.ts`). */
export const TOOL_IMAGES_LABEL = '[Images from your tool calls]';

/**
 * Whether `m` is a message of tool pictures, not something the user wrote. A
 * scan for "the latest user message" means the user's request, so it skips
 * these.
 */
export function isToolImageMessage(m: ChatMessage): boolean {
	if (m.role !== 'user' || typeof m.content === 'string') return false;
	const first = m.content[0];
	return first?.type === 'text' && first.text.startsWith(TOOL_IMAGES_LABEL);
}
