/**
 * Approval prompt for `create_skill` and `update_skill`. Same pattern as
 * memoryApproval.svelte.ts: the tool calls `askSkillApproval`, the modal
 * mounted in the root layout shows the pending request, and the user's choice
 * resolves it.
 *
 * Every write is asked about, with no "for this session": a skill is
 * instructions that steer later turns, and a page the model read could talk
 * it into saving one. The user can edit the text first; the modal saves
 * through `save` and stays open when that fails, so a mistake in an edit is
 * shown to the user rather than handed to the model.
 *
 * Prompts queue (`approvalQueue.svelte.ts`), one shown at a time.
 */

import { createApprovalQueue } from './approvalQueue.svelte.ts';

export interface SkillApprovalRequest {
	/** A skill, or the repo's AGENTS.md (`write_agents_md`). */
	kind: 'skill' | 'agentsMd';
	update: boolean;
	name: string;
	/** The skill's folder, or the AGENTS.md file. */
	dir: string;
	/** Goes in the repo rather than the user's skills. */
	project: boolean;
	text: string;
	/** The file as it is now, when updating. */
	current: string | null;
	/** Write the approved text; rejects with what is wrong with it. */
	save: (text: string) => Promise<void>;
}

export type SkillApprovalResult =
	| { kind: 'saved'; edited: boolean }
	| { kind: 'rejected'; reason: string };

const queue = createApprovalQueue<SkillApprovalRequest, SkillApprovalResult>();

/**
 * Ask about a skill write. Waits behind any prompt already showing (a Chat
 * and a Shell turn can both ask); stopping the turn withdraws it.
 */
export function askSkillApproval(
	request: SkillApprovalRequest,
	signal?: AbortSignal
): Promise<SkillApprovalResult> {
	return queue.ask(request, {
		signal,
		abortResult: { kind: 'rejected', reason: 'The turn was stopped.' }
	});
}

export function getPendingSkillApproval(): SkillApprovalRequest | null {
	return queue.current();
}

export function resolveSkillApproval(result: SkillApprovalResult): void {
	queue.resolve(result);
}
