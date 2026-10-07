/**
 * Asking whether a repo's own instructions may reach a turn.
 *
 * A repo's `.agents/skills/` and its `AGENTS.md` are text
 * written by whoever wrote the repo. For the user's own project that is the
 * point; for a freshly cloned one it is a stranger's instructions injected
 * into every turn. So the first Shell turn in a repo that has either asks
 * once, and the answer is kept in Settings → Skills.
 *
 * Same shape as the other approval stores: the caller awaits a promise, a
 * modal mounted in the root layout renders the pending ask, and a button
 * resolves it. Asks about the same repo share one prompt.
 */

export interface RepoTrustAsk {
	root: string;
	skills: number;
	agentsMd: boolean;
}

interface Pending extends RepoTrustAsk {
	answer: Promise<boolean>;
	resolve: (trusted: boolean) => void;
}

let queue = $state<Pending[]>([]);

export function askRepoTrust(ask: RepoTrustAsk): Promise<boolean> {
	const existing = queue.find((p) => p.root === ask.root);
	if (existing) return existing.answer;
	let resolve!: (trusted: boolean) => void;
	const answer = new Promise<boolean>((r) => (resolve = r));
	queue = [...queue, { ...ask, answer, resolve }];
	return answer;
}

/** The ask on screen, oldest first. */
export function getPendingRepoTrust(): RepoTrustAsk | null {
	return queue[0] ?? null;
}

export function resolveRepoTrust(trusted: boolean): void {
	const [current, ...rest] = queue;
	if (!current) return;
	queue = rest;
	current.resolve(trusted);
}
