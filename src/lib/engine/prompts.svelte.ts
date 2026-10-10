/**
 * What this window's turns are waiting on a person for, as engine prompts,
 * and answering them from elsewhere.
 *
 * Each prompt store keeps its own pending request; a prompt's id is given
 * the first time its request object is seen, so it stays the same while it
 * shows and the next request gets a new one. An answer must name the prompt
 * showing now: two screens answering the same prompt can't have the slower
 * one answer whatever came next.
 */
import { untrack } from 'svelte';
import {
	getPendingCommandApproval,
	getQueuedCommandApprovals,
	resolveCommandApproval
} from '#lib/stores/codeCommandApproval.svelte.ts';
import { getPendingMcpApproval } from '#lib/stores/mcpApproval.svelte.ts';
import {
	getPendingMemoryApproval,
	resolveMemoryApproval
} from '#lib/stores/memoryApproval.svelte.ts';
import { getPendingApproval, resolveApproval } from '#lib/stores/sandboxApproval.svelte.ts';
import { getActiveConversationId } from '#lib/stores/session.svelte.ts';
import { getPendingRepoTrust } from '#lib/stores/repoTrust.svelte.ts';
import { getPendingSkillApproval } from '#lib/stores/skillApproval.svelte.ts';
import { getPendingQuestion, resolveUserQuestion } from '#lib/stores/userQuestion.svelte.ts';
import type { Prompt, PromptAnswer, PromptEvent } from './types.ts';

const ids = new WeakMap<object, string>();
let next = 0;

function idFor(label: string, request: object): string {
	let id = ids.get(request);
	if (!id) {
		id = `${label}:${++next}`;
		ids.set(request, id);
	}
	return id;
}

/** Every prompt showing in this window, oldest kind first. */
export function currentPrompts(label: string): Prompt[] {
	const out: Prompt[] = [];
	const command = getPendingCommandApproval();
	if (command) {
		out.push({
			promptId: idFor(label, command),
			kind: 'command',
			sessionId: command.sessionId,
			answerable: true,
			requester: command.requester,
			detail: {
				command: command.command,
				reasons: command.reasons.map((r) => r.label),
				queued: getQueuedCommandApprovals()
			}
		});
	}
	const question = getPendingQuestion();
	if (question) {
		out.push({
			promptId: idFor(label, question),
			kind: 'question',
			sessionId: question.sessionId ?? null,
			answerable: true,
			requester: null,
			detail: {
				question: question.question,
				body: question.body ?? null,
				options: question.options,
				allowMultiple: question.allowMultiple ?? false
			}
		});
	}
	// The sandbox and memory ask on behalf of the chat that is open.
	const sandbox = getPendingApproval();
	if (sandbox) {
		out.push({
			promptId: idFor(label, sandbox),
			kind: 'sandbox',
			sessionId: null,
			chatId: getActiveConversationId(),
			answerable: true,
			requester: null,
			detail: { code: sandbox.code, mode: sandbox.mode }
		});
	}
	const memory = getPendingMemoryApproval();
	if (memory) {
		out.push({
			promptId: idFor(label, memory),
			kind: 'memory',
			sessionId: null,
			chatId: getActiveConversationId(),
			answerable: true,
			requester: null,
			detail: { content: memory.content, category: memory.category }
		});
	}
	const mcp = getPendingMcpApproval();
	if (mcp) {
		out.push({
			promptId: idFor(label, mcp),
			kind: 'mcp',
			sessionId: null,
			answerable: false,
			requester: null,
			detail: { server: mcp.serverLabel, tool: mcp.toolName }
		});
	}
	const skill = getPendingSkillApproval();
	if (skill) {
		out.push({
			promptId: idFor(label, skill),
			kind: 'skill',
			sessionId: null,
			answerable: false,
			requester: null,
			detail: { kind: skill.kind, name: skill.name, update: skill.update }
		});
	}
	const trust = getPendingRepoTrust();
	if (trust) {
		out.push({
			promptId: idFor(label, trust),
			kind: 'repo-trust',
			sessionId: null,
			answerable: false,
			requester: null,
			detail: { root: trust.root }
		});
	}
	return JSON.parse(JSON.stringify(out)) as Prompt[];
}

/** Answer the prompt `promptId`, which must be the one showing. */
export function answerPrompt(label: string, promptId: string, answer: PromptAnswer): void {
	const prompt = currentPrompts(label).find((p) => p.promptId === promptId);
	if (!prompt) throw new Error(`prompt ${promptId} is not showing (answered, or withdrawn)`);
	if (!prompt.answerable) throw new Error(`a ${prompt.kind} prompt is answered at the desktop`);
	if (prompt.kind !== answer.kind) {
		throw new Error(`prompt ${promptId} is a ${prompt.kind} prompt, not ${answer.kind}`);
	}
	switch (answer.kind) {
		case 'command':
			return resolveCommandApproval(answer.choice);
		case 'question':
			return resolveUserQuestion(answer.answer);
		case 'sandbox':
			return resolveApproval(answer.choice);
		case 'memory':
			return resolveMemoryApproval(answer.choice);
	}
}

/** Send `prompt` and `prompt-cleared` events as this window's prompts change. */
export function watchPrompts(label: string, sink: (e: PromptEvent) => void): () => void {
	let seq = 0;
	// Bookkeeping for the diff below, never rendered: plain Maps, not SvelteMap.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	let shown = new Map<string, Prompt>();
	return $effect.root(() => {
		$effect(() => {
			const now = currentPrompts(label);
			untrack(() => {
				// eslint-disable-next-line svelte/prefer-svelte-reactivity
				const nowIds = new Map(now.map((p) => [p.promptId, p]));
				for (const [id, p] of shown) {
					if (!nowIds.has(id)) {
						sink({ seq: ++seq, sessionId: p.sessionId, type: 'prompt-cleared', promptId: id });
					}
				}
				for (const p of now) {
					const before = shown.get(p.promptId);
					if (!before || JSON.stringify(before) !== JSON.stringify(p)) {
						sink({ seq: ++seq, sessionId: p.sessionId, type: 'prompt', prompt: p });
					}
				}
				shown = nowIds;
			});
		});
	});
}
