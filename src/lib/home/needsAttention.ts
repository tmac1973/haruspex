import type { Prompt } from '#lib/engine/types.ts';

/**
 * The Code sessions that are waiting on the user: each has a prompt showing
 * that names it. Prompts for a chat or a job run, and ones that name no
 * session (a file-exists question), mark nothing.
 */
export function sessionsNeedingAttention(prompts: Prompt[]): Set<string> {
	const ids = new Set<string>();
	for (const p of prompts) {
		if (p.sessionId) ids.add(p.sessionId);
	}
	return ids;
}
