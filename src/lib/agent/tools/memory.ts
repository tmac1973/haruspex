/**
 * Structured-output tool for the memory extraction pass.
 *
 * The extraction turn reads a slice of conversation and reports the durable
 * facts in it by *calling* this tool (forced at the end of the turn). The
 * pipeline captures the arguments off `onToolStart`; this executor only
 * acknowledges, the same shape the audit and planning tools use.
 *
 * Category `'memory'` keeps it out of every default toolset — chat, shell and
 * code turns must never see it, or the model could write to the user's
 * long-term memory as a side effect of an ordinary answer. It appears only
 * when the extraction pass pins it in via `toolAllowlist`.
 *
 * Per the CI grep guard, nothing under `tools/` may import `stores/chat`.
 */

import { registerTool } from './registry';
import { toolResult } from './types';

export const SUBMIT_MEMORIES_TOOL = 'submit_memories';

/** The four kinds of fact worth keeping between conversations. */
export const MEMORY_CATEGORIES = ['preference', 'fact', 'project', 'correction'] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** One candidate memory as the extraction turn reports it. */
export interface SubmittedMemory {
	content: string;
	category: MemoryCategory;
}

registerTool({
	category: 'memory',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_MEMORIES_TOOL,
			description:
				'Report the durable facts worth remembering about this user, as structured ' +
				'data. Call this exactly once, at the end. An empty list is a valid and ' +
				'common answer — most conversations contain nothing worth keeping.',
			parameters: {
				type: 'object',
				properties: {
					memories: {
						type: 'array',
						description:
							'Facts that will still be true next week. Empty when the conversation ' +
							'held none.',
						items: {
							type: 'object',
							properties: {
								content: {
									type: 'string',
									description:
										'One self-contained sentence, in the third person about the user ' +
										'("Prefers tabs over spaces"). It will be read months later with ' +
										'none of this conversation around it, so resolve every pronoun ' +
										'and reference.'
								},
								category: {
									type: 'string',
									enum: [...MEMORY_CATEGORIES],
									description:
										'preference = how they like things done; fact = stable ' +
										'biographical or environmental detail; project = standing ' +
										'context about work they return to; correction = something they ' +
										'told you that you had wrong.'
								}
							},
							required: ['content', 'category']
						}
					}
				},
				required: ['memories']
			}
		}
	},
	displayLabel: (args) => {
		const n = Array.isArray(args.memories) ? args.memories.length : 0;
		return n === 0 ? 'no new memories' : `${n} memor${n === 1 ? 'y' : 'ies'}`;
	},
	// The pipeline reads the arguments off onToolStart; this just ends the turn.
	async execute() {
		return toolResult('Memories recorded.');
	}
});

/**
 * Keep only well-formed candidates from a `submit_memories` call.
 *
 * A local 9B produces the right shape most of the time, not all of it. The
 * cost of a malformed row is not a crash — it is a permanent, unreadable
 * entry in the user's memory that gets injected into future prompts — so
 * anything that isn't a plain sentence with a known category is dropped
 * rather than coerced.
 */
export function parseSubmittedMemories(
	args: Record<string, unknown> | undefined
): SubmittedMemory[] {
	const raw = args?.memories;
	if (!Array.isArray(raw)) return [];
	const out: SubmittedMemory[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const record = item as Record<string, unknown>;
		const content = typeof record.content === 'string' ? record.content.trim() : '';
		// Two words is not a memory, and a paragraph is a summary rather than a
		// fact — both make poor prompt material and worse manager rows.
		if (content.length < 8 || content.length > 400) continue;
		const category = MEMORY_CATEGORIES.includes(record.category as MemoryCategory)
			? (record.category as MemoryCategory)
			: 'fact';
		out.push({ content, category });
	}
	return out;
}
