import { chatCompletion, messageText, type ChatMessage } from '$lib/api';
import { getChatTemplateKwargs } from '$lib/stores/settings';

const COMPACTION_THRESHOLD = 0.8;
const PROTECTED_TURNS = 4;

export function shouldCompact(promptTokens: number, contextSize: number): boolean {
	if (contextSize === 0 || promptTokens === 0) return false;
	return promptTokens / contextSize >= COMPACTION_THRESHOLD;
}

export async function compactConversation(
	messages: ChatMessage[],
	signal?: AbortSignal
): Promise<{ summary: string; removedCount: number }> {
	// Split into user/assistant messages only (tool messages should already be stripped)
	const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');

	// Keep the last PROTECTED_TURNS pairs (up to PROTECTED_TURNS * 2 messages)
	const protectedCount = PROTECTED_TURNS * 2;
	if (turns.length <= protectedCount) {
		return { summary: '', removedCount: 0 };
	}

	const compactable = turns.slice(0, turns.length - protectedCount);
	if (compactable.length === 0) {
		return { summary: '', removedCount: 0 };
	}

	// Format the compactable messages for summarization
	const formatted = compactable
		.map((m) => {
			const role = m.role === 'user' ? 'User' : 'Assistant';
			// Strip think blocks from assistant messages for cleaner summary
			const content = messageText(m.content)
				.replace(/<think>[\s\S]*?<\/think>\s*/g, '')
				.trim();
			return `${role}: ${content}`;
		})
		.join('\n\n');

	const response = await chatCompletion(
		{
			messages: [
				{
					role: 'system',
					content:
						'Summarize the following conversation concisely, preserving key facts, decisions, user preferences, and context needed to continue the conversation naturally. Be thorough but brief. Output only the summary, no preamble.'
				},
				{
					role: 'user',
					content: formatted
				}
			],
			max_tokens: 1024,
			temperature: 0.3,
			chat_template_kwargs: getChatTemplateKwargs()
		},
		signal
	);

	const summary = response.content?.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim() || '';

	// Count how many messages from the original array to remove
	// We need to find the compactable messages in the original array
	const compactableSet = new Set(compactable);
	let removedCount = 0;
	for (const m of messages) {
		if (compactableSet.has(m)) removedCount++;
	}

	return { summary, removedCount };
}
