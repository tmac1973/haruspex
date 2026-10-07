/**
 * The repo a Shell turn may take instructions from: the root of the repo the
 * shell sits in, once the user trusts it.
 */

import { invoke } from '@tauri-apps/api/core';
import type { AgentsMd } from '#lib/ipc/gen/AgentsMd.ts';
import type { ProjectInstructions } from '#lib/ipc/gen/ProjectInstructions.ts';
import { askRepoTrust } from '#lib/stores/repoTrust.svelte.ts';
import { getSettings, updateSkills } from '#lib/stores/settings.ts';
import { loadAgentsMd } from './agentsMd';
import { repoTrust } from './client';

/**
 * The trusted repo root for a shell in `cwd`, or null: outside a repo, a repo
 * the user declined, or one with nothing to contribute. The first time a repo
 * with project skills or an `AGENTS.md` turns up, this asks the user and
 * records the answer — so it can wait on a modal.
 */
export async function trustedProjectRoot(cwd: string | null): Promise<string | null> {
	if (!cwd) return null;
	const root = await invoke<string | null>('skills_project_root', { cwd }).catch(() => null);
	if (!root) return null;
	const known = repoTrust(root);
	if (known !== undefined) return known ? root : null;

	const info = await invoke<ProjectInstructions>('skills_project_info', { root }).catch(() => null);
	// Nothing to trust: don't ask, and don't record an answer the user never gave.
	if (!info || (info.skills === 0 && !info.agentsMd)) return null;
	const trusted = await askRepoTrust({ root, skills: info.skills, agentsMd: info.agentsMd });
	updateSkills({ trustedRepos: { ...getSettings().skills.trustedRepos, [root]: trusted } });
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
