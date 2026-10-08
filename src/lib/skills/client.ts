/**
 * The frontend's way to skills (`src-tauri/src/skills/`). Rust finds and
 * parses them; this decides which folders it may search and which of the
 * skills it finds a turn may use.
 *
 * Two rules live here so no caller has to remember them:
 *  - A project's skills are searched only when the user trusts that repo.
 *  - A skill reaches a turn only when it is usable: no parse error, not
 *    overridden by a same-named skill, and not switched off.
 */

import { invoke } from '@tauri-apps/api/core';
import type { BackendOverride } from '#lib/api.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import type { AgentsMdDraft } from '#lib/ipc/gen/AgentsMdDraft.ts';
import type { SkillDoc } from '#lib/ipc/gen/SkillDoc.ts';
import type { SkillDraft } from '#lib/ipc/gen/SkillDraft.ts';
import type { SkillSummary } from '#lib/ipc/gen/SkillSummary.ts';
import type { SkillWriteRequest } from '#lib/ipc/gen/SkillWriteRequest.ts';
import { getSettings } from '#lib/stores/settings.ts';

/**
 * Whether the user said yes to `root`'s instructions: true or false once
 * asked, undefined before.
 */
export function repoTrust(root: string): boolean | undefined {
	return getSettings().skills.trustedRepos[root]?.trusted;
}

/** The folders Rust may search: extra folders always, the project only if trusted. */
function searchArgs(projectRoot?: string | null) {
	return {
		extraDirs: getSettings().skills.extraDirs,
		projectRoot: projectRoot && repoTrust(projectRoot) === true ? projectRoot : null
	};
}

/** Every skill found, usable or not, for Settings. */
export function listSkills(projectRoot?: string | null): Promise<SkillSummary[]> {
	return invoke<SkillSummary[]>('skills_list', searchArgs(projectRoot));
}

/** Only for Code mode (`metadata.haruspex-mode: code`), such as `/init`. */
export function codeModeOnly(skill: SkillSummary): boolean {
	return skill.codeModeOnly;
}

/**
 * Skills a turn may use: parsed, not overridden, not switched off, and
 * outside Code mode not one that needs it.
 */
export function usableSkills(all: SkillSummary[], codeMode = false): SkillSummary[] {
	const disabled = new Set(getSettings().skills.disabled);
	return all.filter(
		(s) => !s.error && !s.shadowed && !disabled.has(s.name) && (codeMode || !codeModeOnly(s))
	);
}

export function readSkill(name: string, projectRoot?: string | null): Promise<SkillDoc> {
	return invoke<SkillDoc>('skill_read', { name, ...searchArgs(projectRoot) });
}

export function readSkillFile(
	name: string,
	path: string,
	projectRoot?: string | null
): Promise<string> {
	return invoke<string>('skill_read_file', { name, path, ...searchArgs(projectRoot) });
}

/**
 * Check what the model asked to write and build the `SKILL.md` to show the
 * user. Rejects with the reason the request was turned back.
 */
export function draftSkill(
	request: SkillWriteRequest,
	projectRoot?: string | null
): Promise<SkillDraft> {
	return invoke<SkillDraft>('skill_draft', { request, ...searchArgs(projectRoot) });
}

/** Write the text the user approved; resolves to the file written. */
export function saveSkill(
	request: SkillWriteRequest,
	text: string,
	projectRoot?: string | null
): Promise<string> {
	return invoke<string>('skill_save', { request, text, ...searchArgs(projectRoot) });
}

/** Where `write_agents_md` writes for a shell in `cwd`, and what is there now. */
export function draftAgentsMd(cwd: string): Promise<AgentsMdDraft> {
	return invoke<AgentsMdDraft>('agents_md_draft', { cwd });
}

/** Write the repo's AGENTS.md as the user approved it; resolves to its path. */
export function saveAgentsMd(cwd: string, text: string): Promise<string> {
	return invoke<string>('agents_md_save', { cwd, text });
}

/**
 * Whether the model sees the skill list and may load a skill by itself on
 * `backend` (the turn's override, or Settings when absent). `auto` keeps it
 * off for the local model: "notice a skill applies, load it, then follow it"
 * is the multi-step shape a 9B model does only the first step of.
 */
export function skillsAutonomous(backend?: BackendOverride): boolean {
	const setting = getSettings().skills.autonomous;
	if (setting !== 'auto') return setting === 'on';
	return resolveBackendDescriptor(backend).kind !== 'local';
}
