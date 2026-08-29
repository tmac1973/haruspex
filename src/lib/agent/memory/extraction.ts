/**
 * Distil durable facts out of finished conversation turns.
 *
 * Reads the transcript from the DATABASE rather than the in-memory history:
 * compaction rewrites a long conversation into a summary at 80% context, and
 * anything it folded away would otherwise be lost to memory forever. The db
 * still holds the real turns.
 *
 * A watermark (`conversations.memory_extracted_to`) marks the highest message
 * `sort_order` already processed, so each pass only reads what is new. It is
 * advanced only after the facts are stored, which makes a killed app re-extract
 * rather than lose — dedupe makes that retry harmless.
 *
 * See `plan/agentic-memory/phase-03-extraction-pipeline.md`.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ConversationWithMessages } from '$lib/ipc/gen/ConversationWithMessages';
import type { MemoryCursor } from '$lib/ipc/gen/MemoryCursor';
import type { MemoryHit } from '$lib/ipc/gen/MemoryHit';
import { runEphemeralTurn } from '$lib/agent/runEphemeralTurn';
import { withInferenceSlot } from '$lib/agent/inferenceQueue.svelte';
import { resolveBackendDescriptor } from '$lib/inference/descriptor';
import { parseSubmittedMemories, SUBMIT_MEMORIES_TOOL } from '$lib/agent/tools/memory';
import { memoryActive, refreshMemoryCount } from '$lib/stores/memory.svelte';
import { logDebug } from '$lib/debug-log';
import { extractionSystemPrompt, extractionUserMessage } from './extractionPrompt';

/**
 * Two exchanges. Below this there is rarely a durable fact, and an extraction
 * turn costs a model call on a machine that may have one inference slot.
 */
const MIN_NEW_MESSAGES = 4;

/**
 * Transcript ceiling, in characters. Roughly 6k tokens — comfortably inside
 * any context this app supports, and bounded so a long unextracted backlog
 * cannot build a prompt that overflows.
 */
const MAX_TRANSCRIPT_CHARS = 24_000;

/**
 * Cosine at or above which a candidate is the same fact as one already
 * stored. 0.90 on normalized BGE embeddings is "a paraphrase", not "related".
 */
const DEDUPE_THRESHOLD = 0.9;

/** Roles worth reading. Tool output is untrusted data, never a user statement. */
const EXTRACTABLE_ROLES = new Set(['user', 'assistant']);

export interface ExtractionResult {
	/** Facts newly written to the store. */
	added: number;
	/** Candidates that matched something already known, and bumped it instead. */
	deduped: number;
	/** Why the pass did nothing, when it did nothing. */
	skipped?: 'inactive' | 'incognito' | 'too-short' | 'no-model' | 'failed';
}

/**
 * One message as the extraction prompt sees it. `sort_order` is what advances
 * the watermark, so it travels with the text.
 */
interface TranscriptMessage {
	role: string;
	content: string;
	sortOrder: number;
}

/**
 * The new turns for a conversation, oldest first.
 *
 * Tool messages are dropped here rather than filtered in the prompt: a web
 * page or file the assistant read is untrusted text, and a document saying
 * "remember X" must never be able to write to the user's long-term memory.
 * The prompt repeats the rule, but this is the guard that holds.
 */
export function collectNewTurns(
	conversation: ConversationWithMessages,
	extractedTo: number
): TranscriptMessage[] {
	return conversation.messages
		.filter((m) => m.sort_order > extractedTo)
		.filter((m) => EXTRACTABLE_ROLES.has(m.role))
		.filter((m) => m.content.trim().length > 0)
		.map((m) => ({ role: m.role, content: m.content, sortOrder: m.sort_order }));
}

/**
 * Render the slice as a transcript, keeping the NEWEST messages when it does
 * not all fit — the recent end of a conversation is where a standing fact is
 * most likely to have been stated, and the older end will already have been
 * offered to an earlier pass.
 */
export function renderTranscript(messages: TranscriptMessage[]): string {
	const lines: string[] = [];
	let total = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`;
		if (total + line.length > MAX_TRANSCRIPT_CHARS) break;
		lines.unshift(line);
		total += line.length;
	}
	return lines.join('\n\n');
}

/**
 * Run one extraction pass over a conversation's unextracted turns.
 *
 * Silent about its failures by design: this is a background nicety, and an
 * error toast for something the user never asked to happen is worse than the
 * missed facts. Everything is logged.
 */
export async function extractMemories(conversationId: string): Promise<ExtractionResult> {
	if (!memoryActive()) return { added: 0, deduped: 0, skipped: 'inactive' };

	const cursor = await invoke<MemoryCursor>('conversation_memory_cursor', { conversationId });
	// Incognito, or a conversation that has since been deleted (the cursor
	// reads disabled for a row that isn't there).
	if (!cursor.memory_enabled) return { added: 0, deduped: 0, skipped: 'incognito' };

	const conversation = await invoke<ConversationWithMessages>('db_get_conversation', {
		id: conversationId
	});
	const fresh = collectNewTurns(conversation, cursor.memory_extracted_to);
	if (fresh.length < MIN_NEW_MESSAGES) return { added: 0, deduped: 0, skipped: 'too-short' };

	const highWater = Math.max(...fresh.map((m) => m.sortOrder));
	const descriptor = resolveBackendDescriptor();

	let submitted: ReturnType<typeof parseSubmittedMemories> = [];
	try {
		// Inside the slot: extraction must queue behind whatever the user is
		// actually doing. On a single-slot local server, competing with a live
		// chat turn would be felt immediately.
		await withInferenceSlot(
			{ consumer: 'memory' },
			async () =>
				await runEphemeralTurn({
					userMessage: extractionUserMessage(renderTranscript(fresh)),
					systemPrompt: extractionSystemPrompt(),
					workingDir: null,
					contextSize: descriptor.contextSize,
					visionSupported: false,
					// Nobody is watching: an extraction that stopped to ask a
					// question would park forever.
					interactive: false,
					maxIterations: 2,
					toolAllowlist: [SUBMIT_MEMORIES_TOOL],
					forceFinalTool: SUBMIT_MEMORIES_TOOL,
					onToolStart: (call) => {
						if (call.name === SUBMIT_MEMORIES_TOOL) {
							submitted = parseSubmittedMemories(call.arguments);
						}
					}
				})
		);
	} catch (e) {
		logDebug('memory', 'extraction turn failed', { conversationId, error: String(e) });
		return { added: 0, deduped: 0, skipped: 'failed' };
	}

	const result = await storeCandidates(submitted, conversationId);

	// Only now: a crash before this point re-reads the same turns next time,
	// which dedupe absorbs. Advancing first would lose them silently.
	await invoke('conversation_set_memory_extracted_to', {
		conversationId,
		sortOrder: highWater
	});
	if (result.added > 0) void refreshMemoryCount();
	logDebug('memory', 'extraction pass complete', { conversationId, ...result });
	return result;
}

/**
 * Store the candidates that are actually new.
 *
 * A near-duplicate bumps the existing row instead of adding another: the same
 * preference stated in three conversations is one fact observed three times,
 * and recording it three times would let it dominate every recall.
 */
async function storeCandidates(
	candidates: ReturnType<typeof parseSubmittedMemories>,
	conversationId: string
): Promise<ExtractionResult> {
	let added = 0;
	let deduped = 0;
	for (const candidate of candidates) {
		try {
			const existing = await invoke<MemoryHit | null>('memory_find_similar', {
				content: candidate.content,
				threshold: DEDUPE_THRESHOLD
			});
			if (existing) {
				await invoke('memory_touch', { id: existing.id });
				deduped++;
				continue;
			}
			await invoke('memory_add', {
				content: candidate.content,
				category: candidate.category,
				sourceConversationId: conversationId
			});
			added++;
		} catch (e) {
			// One bad candidate must not abandon the rest of the batch.
			logDebug('memory', 'storing a candidate failed', {
				content: candidate.content.slice(0, 60),
				error: String(e)
			});
		}
	}
	return { added, deduped };
}
