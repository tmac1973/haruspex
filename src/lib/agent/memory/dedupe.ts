/**
 * Catching memories that say what another already says.
 *
 * Similarity alone can't do it. Paraphrases of one fact score 0.87–0.89, just
 * under the 0.90 the extraction pass drops repeats at, and a fact that adds a
 * detail ("is building Haruspex, and adding 3D model generation") scores
 * about 0.77 against the plain one, the same as two unrelated facts about the
 * same person. So anything within REVIEW_SIMILARITY goes to the model, which
 * reads both and says whether they are the same.
 *
 * Two places use it:
 * - extraction (`reviewCandidates`): each new fact with close stored
 *   memories is judged same, update or new before anything is written;
 * - Settings → Memory's tidy-up (`findDuplicateGroups`): stored memories
 *   that read alike are grouped, each group with a merged sentence the user
 *   approves, edits or skips.
 *
 * A memory the user saved themselves (`origin: explicit`) is never rewritten
 * by extraction: a new fact can only be the same as it, or new.
 */

import { invoke } from '@tauri-apps/api/core';
import type { MemoryHit } from '#lib/ipc/gen/MemoryHit.ts';
import type { MemoryMeta } from '#lib/ipc/gen/MemoryMeta.ts';
import type { MemoryPair } from '#lib/ipc/gen/MemoryPair.ts';
import { runEphemeralTurn } from '#lib/agent/runEphemeralTurn.ts';
import { withInferenceSlot } from '#lib/agent/inferenceQueue.svelte.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import {
	GROUP_MEMORIES_TOOL,
	RESOLVE_MEMORIES_TOOL,
	type SubmittedMemory
} from '#lib/agent/tools/memory.ts';

/** Stored memories at least this alike are shown to the model to judge. */
export const REVIEW_SIMILARITY = 0.7;
/** At most this many stored memories beside each new fact. */
const NEIGHBORS = 3;
/** At most this many candidate pairs in one tidy-up. */
const MAX_PAIRS = 40;

export interface ReviewItem {
	candidate: SubmittedMemory;
	neighbors: MemoryHit[];
}

export type Decision =
	| { action: 'new' }
	| { action: 'same'; id: string }
	| { action: 'update'; id: string; content: string };

/** The stored memories close to `content`, for the review. */
export function closeMemories(content: string): Promise<MemoryHit[]> {
	return invoke<MemoryHit[]>('memory_neighbors', {
		content,
		k: NEIGHBORS,
		minSimilarity: REVIEW_SIMILARITY
	});
}

const asString = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A sentence fit to store, by the same limits as `parseSubmittedMemories`. */
const storable = (s: string) => s.length >= 8 && s.length <= 400;

/**
 * The model's decisions, one per item, checked: an id must be one of that
 * fact's own neighbours, an update needs a storable sentence, and a memory the
 * user saved themselves can only be matched, never rewritten. Anything else,
 * or a fact the model skipped, is new.
 */
export function parseDecisions(args: unknown, items: ReviewItem[]): Decision[] {
	const out: Decision[] = items.map(() => ({ action: 'new' }));
	const raw = (args as { decisions?: unknown } | undefined)?.decisions;
	if (!Array.isArray(raw)) return out;
	for (const d of raw) {
		if (!d || typeof d !== 'object') continue;
		const r = d as Record<string, unknown>;
		const i = Number(r.fact) - 1;
		if (!Number.isInteger(i) || i < 0 || i >= items.length) continue;
		const target = items[i].neighbors.find((n) => n.id === asString(r.memory_id));
		if (r.action === 'same' && target) {
			out[i] = { action: 'same', id: target.id };
		} else if (r.action === 'update' && target) {
			const content = asString(r.content);
			out[i] =
				target.origin === 'explicit' || !storable(content)
					? { action: 'same', id: target.id }
					: { action: 'update', id: target.id, content };
		}
	}
	return out;
}

function reviewSystemPrompt(): string {
	return [
		"You keep a personal assistant's long-term memory free of duplicates.",
		'Each NEW FACT below was just learned about the user, and is shown with the stored',
		'memories that read most like it. For each new fact, decide:',
		'- same: a stored memory already says this, even in other words. Nothing is added.',
		'- update: it is about the same thing as a stored memory and adds a detail worth',
		'  keeping. Give that memory rewritten as ONE sentence holding everything true from',
		'  both, third person about the user. Only for memories marked (learned).',
		'- new: it is about something else, or the stored memories are only related.',
		'Two facts about the same project, tool or piece of hardware are the same thing.',
		'If they disagree, prefer the stored memory unless the new fact is clearly a',
		'correction. When unsure between same and new, choose new.',
		`Report by calling \`${RESOLVE_MEMORIES_TOOL}\` once, with a decision for every fact.`
	].join('\n');
}

function reviewMessage(items: ReviewItem[]): string {
	return items
		.map((item, i) => {
			const stored = item.neighbors
				.map(
					(n) =>
						`  - [${n.id}] ${n.content} (${n.origin === 'explicit' ? 'saved by the user' : 'learned'})`
				)
				.join('\n');
			return `NEW FACT ${i + 1}: ${item.candidate.content}\nStored memories like it:\n${stored}`;
		})
		.join('\n\n');
}

/**
 * Ask the model about the new facts that read like stored memories. Throws
 * when the turn fails; the caller then stores them as new, which is what
 * happened before this review existed.
 */
export async function reviewCandidates(items: ReviewItem[]): Promise<Decision[]> {
	let args: unknown;
	await withInferenceSlot({ consumer: 'memory' }, () =>
		runEphemeralTurn({
			userMessage: reviewMessage(items),
			systemPrompt: reviewSystemPrompt(),
			workingDir: null,
			contextSize: resolveBackendDescriptor().contextSize,
			visionSupported: false,
			interactive: false,
			maxIterations: 2,
			toolAllowlist: [RESOLVE_MEMORIES_TOOL],
			forceFinalTool: RESOLVE_MEMORIES_TOOL,
			onToolStart: (call) => {
				if (call.name === RESOLVE_MEMORIES_TOOL) args = call.arguments;
			}
		})
	);
	return parseDecisions(args, items);
}

/** Stored memories the tidy-up suggests merging into one. */
export interface DuplicateGroup {
	memories: MemoryMeta[];
	/** The model's sentence for the merged memory; the user may edit it. */
	content: string;
	/** The memory that stays: one the user saved, else the oldest. */
	keepId: string;
}

/** The memory to keep from a group: one the user saved, else the oldest. */
export function keeper(memories: MemoryMeta[]): MemoryMeta {
	return [...memories].sort(
		(a, b) =>
			Number(b.origin === 'explicit') - Number(a.origin === 'explicit') ||
			a.created_at - b.created_at
	)[0];
}

/**
 * The model's groups, checked: ids it was shown, at least two per group, no
 * memory in two groups, and a storable sentence.
 */
export function parseGroups(args: unknown, shown: Map<string, MemoryMeta>): DuplicateGroup[] {
	const raw = (args as { groups?: unknown } | undefined)?.groups;
	if (!Array.isArray(raw)) return [];
	const used = new Set<string>();
	const out: DuplicateGroup[] = [];
	for (const g of raw) {
		if (!g || typeof g !== 'object') continue;
		const r = g as Record<string, unknown>;
		const ids = Array.isArray(r.ids)
			? [...new Set(r.ids.map(asString))].filter((id) => shown.has(id) && !used.has(id))
			: [];
		const content = asString(r.content);
		if (ids.length < 2 || !storable(content)) continue;
		ids.forEach((id) => used.add(id));
		const memories = ids.map((id) => shown.get(id)!);
		out.push({ memories, content, keepId: keeper(memories).id });
	}
	return out;
}

function groupSystemPrompt(): string {
	return [
		"You tidy a personal assistant's long-term memory. Below are stored memories about",
		'the user, and pairs of them that read alike. Find the ones that are duplicates: they',
		'say the same thing, or one adds a detail to the other about the same project, tool,',
		'device or preference. Memories that are only related are not duplicates.',
		'For each group of duplicates, write ONE sentence, third person about the user, that',
		'keeps everything true from the group. Where they disagree, keep what is most likely',
		'right, and favour memories marked (saved by the user).',
		`Report by calling \`${GROUP_MEMORIES_TOOL}\` once. An empty list is fine.`
	].join('\n');
}

function groupMessage(memories: MemoryMeta[], pairs: MemoryPair[]): string {
	const list = memories
		.map(
			(m) =>
				`- [${m.id}] ${m.content} (${m.origin === 'explicit' ? 'saved by the user' : 'learned'})`
		)
		.join('\n');
	const alike = pairs.map((p) => `- ${p.a.id} and ${p.b.id}`).join('\n');
	return `MEMORIES:\n${list}\n\nPAIRS THAT READ ALIKE:\n${alike}`;
}

/**
 * The tidy-up's suggestions: stored memories that read alike, grouped by the
 * model into real duplicates, each with a merged sentence. Empty when nothing
 * reads alike.
 */
export async function findDuplicateGroups(): Promise<DuplicateGroup[]> {
	const pairs = await invoke<MemoryPair[]>('memory_similar_pairs', {
		minSimilarity: REVIEW_SIMILARITY,
		limit: MAX_PAIRS
	});
	if (pairs.length === 0) return [];
	const shown = new Map<string, MemoryMeta>();
	for (const p of pairs) {
		shown.set(p.a.id, p.a);
		shown.set(p.b.id, p.b);
	}
	let args: unknown;
	await withInferenceSlot({ consumer: 'memory' }, () =>
		runEphemeralTurn({
			userMessage: groupMessage([...shown.values()], pairs),
			systemPrompt: groupSystemPrompt(),
			workingDir: null,
			contextSize: resolveBackendDescriptor().contextSize,
			visionSupported: false,
			interactive: false,
			maxIterations: 2,
			toolAllowlist: [GROUP_MEMORIES_TOOL],
			forceFinalTool: GROUP_MEMORIES_TOOL,
			onToolStart: (call) => {
				if (call.name === GROUP_MEMORIES_TOOL) args = call.arguments;
			}
		})
	);
	return parseGroups(args, shown);
}

/** Merge a group the user approved: the keeper takes `content`, the rest go. */
export function mergeGroup(group: DuplicateGroup, content: string): Promise<void> {
	return invoke('memory_merge', {
		keepId: group.keepId,
		deleteIds: group.memories.map((m) => m.id).filter((id) => id !== group.keepId),
		content
	});
}
