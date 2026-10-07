/**
 * The repo a Shell turn may take instructions from: the root of the repo the
 * shell sits in, once the user trusts it.
 *
 * An answer lasts, but only for the repo it was given about. It records the
 * repo's `origin` and its project skills, and the user is asked again when a
 * different repo turns up at the same path, or when a trusted repo gains a
 * skill: skills can run commands, and a new one arrives with a `git pull`
 * nobody reads. AGENTS.md edits don't ask again — in your own repo you make
 * them all the time, and it's guidance rather than something that runs.
 */

import { invoke } from '@tauri-apps/api/core';
import type { AgentsMd } from '#lib/ipc/gen/AgentsMd.ts';
import type { ProjectInstructions } from '#lib/ipc/gen/ProjectInstructions.ts';
import { askRepoTrust, type RepoTrustChange } from '#lib/stores/repoTrust.svelte.ts';
import { getSettings, updateSkills, type RepoTrust } from '#lib/stores/settings.ts';
import { loadAgentsMd } from './agentsMd';

/** Record (or, with null, forget) the answer for `root`. */
export function setRepoTrust(root: string, answer: RepoTrust | null): void {
	const trustedRepos = { ...getSettings().skills.trustedRepos };
	if (answer) trustedRepos[root] = answer;
	else delete trustedRepos[root];
	updateSkills({ trustedRepos });
}

/** Keep the answer for `root`, flipping only whether it's trusted. */
export function setRepoTrusted(root: string, trusted: boolean): void {
	setRepoTrust(root, { ...getSettings().skills.trustedRepos[root], trusted });
}

/**
 * Count a project skill the user just approved as one the repo already had,
 * so saving it doesn't make the next turn ask about a new skill.
 */
export function noteProjectSkill(root: string, name: string): void {
	const known = getSettings().skills.trustedRepos[root];
	if (!known?.trusted || !known.skills || known.skills.includes(name)) return;
	setRepoTrust(root, { ...known, skills: [...known.skills, name].sort() });
}

/**
 * After the user approves an AGENTS.md for the repo `cwd` is in: whether
 * turns there will read it. A repo never asked about had nothing to trust, so
 * the file the user just approved is taken as trusted rather than asked about
 * on the next turn. An earlier answer stands, a "no" included.
 */
export async function trustApprovedAgentsMd(cwd: string): Promise<boolean> {
	const root = await invoke<string | null>('skills_project_root', { cwd }).catch(() => null);
	if (!root) return false;
	const known = getSettings().skills.trustedRepos[root];
	if (known) return known.trusted;
	const info = await invoke<ProjectInstructions>('skills_project_info', { root }).catch(() => null);
	// Skills the user hasn't seen still need the prompt.
	if (!info || info.skillNames.length > 0) return false;
	setRepoTrust(root, { trusted: true, origin: info.origin, skills: [] });
	return true;
}

/**
 * What makes an earlier answer about this path out of date, or null. Answers
 * from before the origin and skills were recorded are taken as they stand.
 */
export function trustChange(known: RepoTrust, info: ProjectInstructions): RepoTrustChange | null {
	if (known.origin !== undefined && known.origin !== info.origin) {
		return { kind: 'origin', was: known.origin, now: info.origin };
	}
	if (known.trusted && known.skills) {
		const added = info.skillNames.filter((n) => !known.skills!.includes(n));
		if (added.length > 0) return { kind: 'skills', added };
	}
	return null;
}

/** The answer as it should now be stored: same verdict, current repo. */
function refreshed(known: RepoTrust, info: ProjectInstructions): RepoTrust {
	return { trusted: known.trusted, origin: info.origin, skills: info.skillNames };
}

function sameRecord(a: RepoTrust, b: RepoTrust): boolean {
	return (
		a.trusted === b.trusted &&
		a.origin === b.origin &&
		JSON.stringify(a.skills) === JSON.stringify(b.skills)
	);
}

/**
 * The trusted repo root for a shell in `cwd`, or null: outside a repo, a repo
 * the user declined, or one with nothing to contribute. Asks the user when a
 * repo with project skills or an `AGENTS.md` turns up for the first time, or
 * when an earlier answer no longer fits it (`trustChange`) — so it can wait on
 * a modal.
 */
export async function trustedProjectRoot(cwd: string | null): Promise<string | null> {
	if (!cwd) return null;
	const root = await invoke<string | null>('skills_project_root', { cwd }).catch(() => null);
	if (!root) return null;
	const known = getSettings().skills.trustedRepos[root];
	const info = await invoke<ProjectInstructions>('skills_project_info', { root }).catch(() => null);
	// Can't tell what's there: stand by the last answer rather than ask blind.
	if (!info) return known?.trusted ? root : null;
	// Nothing to trust: don't ask, and don't record an answer the user never gave.
	if (info.skillNames.length === 0 && !info.agentsMd) return null;

	const change = known ? trustChange(known, info) : null;
	if (known && !change) {
		// Keep the record current, so a skill removed and later re-added, or
		// an answer from before origins were kept, is judged against today.
		const now = refreshed(known, info);
		if (!sameRecord(known, now)) setRepoTrust(root, now);
		return known.trusted ? root : null;
	}
	const trusted = await askRepoTrust({
		root,
		skills: info.skillNames.length,
		agentsMd: info.agentsMd,
		change: change ?? undefined
	});
	setRepoTrust(root, { trusted, origin: info.origin, skills: info.skillNames });
	return trusted ? root : null;
}

/**
 * What a Shell turn in `cwd` takes from its repo: the trusted root (for
 * project skills, which only Code mode uses) and its `AGENTS.md`. Both empty
 * outside a trusted repo.
 */
export async function shellProject(
	cwd: string | null
): Promise<{ root: string | null; agentsMd: AgentsMd | null }> {
	const root = await trustedProjectRoot(cwd);
	return { root, agentsMd: root ? await loadAgentsMd(root, cwd) : null };
}
