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
 */

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

interface Pending extends SkillApprovalRequest {
	resolve: (result: SkillApprovalResult) => void;
}

// Raw, so the abort handler can tell its own entry by identity.
let pending = $state.raw<Pending | null>(null);

export function askSkillApproval(
	request: SkillApprovalRequest,
	signal?: AbortSignal
): Promise<SkillApprovalResult> {
	if (pending !== null) {
		return Promise.reject(new Error('A skill approval prompt is already pending.'));
	}
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve({ kind: 'rejected', reason: 'The turn was stopped.' });
		const entry: Pending = { ...request, resolve };
		pending = entry;
		// Stopping the turn closes the prompt rather than leaving it for nobody.
		signal?.addEventListener(
			'abort',
			() => {
				if (pending === entry)
					resolveSkillApproval({ kind: 'rejected', reason: 'The turn was stopped.' });
			},
			{ once: true }
		);
	});
}

export function getPendingSkillApproval(): SkillApprovalRequest | null {
	return pending;
}

export function resolveSkillApproval(result: SkillApprovalResult): void {
	const current = pending;
	if (current === null) return;
	pending = null;
	current.resolve(result);
}
