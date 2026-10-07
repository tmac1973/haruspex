/**
 * A repo's `AGENTS.md` for a Code mode turn: read through Rust
 * (`skills/agents_md.rs`) from a repo the user trusts, and rendered as the
 * prompt section that carries it.
 */

import { invoke } from '@tauri-apps/api/core';
import type { AgentsMd } from '#lib/ipc/gen/AgentsMd.ts';

/** The repo's instructions for a turn in `cwd`, or null. Never throws. */
export async function loadAgentsMd(root: string, cwd: string | null): Promise<AgentsMd | null> {
	return invoke<AgentsMd | null>('skills_agents_md', { root, cwd: cwd ?? root }).catch(() => null);
}

/** The system-prompt section carrying the repo's instructions; empty without any. */
export function agentsMdPromptSection(md: AgentsMd | null): string {
	if (!md) return '';
	const cut = md.truncated
		? `\n[Cut at ${Math.round(md.text.length / 1024)} KB of ${Math.round(md.totalBytes / 1024)} KB. Read the file itself for the rest.]`
		: '';
	return `

PROJECT INSTRUCTIONS:
The repo's own instructions: how to build, test and lint it, and its conventions. Answer from them when they cover the question, without reading files to confirm. Where they differ from the rules above, they win.
${md.text}${cut}`;
}

/** The sidebar badge's tooltip: which files, and whether they were cut. */
export function describeAgentsMd(md: AgentsMd): string {
	const files = md.files.join(', ');
	return md.truncated
		? `Using ${files}, cut to ${Math.round(md.text.length / 1024)} KB of ${Math.round(md.totalBytes / 1024)} KB`
		: `Using ${files}`;
}
