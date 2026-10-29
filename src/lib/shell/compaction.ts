/**
 * Compaction for a Shell tab's assistant thread. The Code tab's machinery
 * (`code/compaction.ts`) does the work: a summary stands in for the older
 * turns, the thread itself is kept, and `at` marks where the summary ends.
 * What differs is the prompt and the header: a shell session is about a
 * machine's state, not a project's files.
 *
 * Shell threads keep every tool call and result between turns, so a few
 * turns of `shell_read` can fill the window. Without a summary, the
 * per-request fit dropped the oldest turns outright, the user's answers to
 * the assistant's questions among them.
 */

import type { ChatMessage } from '#lib/api.ts';
import type { CodeCompaction } from '#lib/code/session.ts';
import { modelThread } from '#lib/code/compaction.ts';

const SHELL_SUMMARY_HEADER =
	"[Summary of this chat's earlier turns. The system may have changed since: " +
	'check its state again rather than relying on this.]';

export const SHELL_SUMMARY_PROMPT = `You summarise a terminal session between a user and an AI assistant that runs commands in the user's shell, so the assistant can carry on without the turns you summarise. Write plain prose and short lists under these headings, leaving out any with nothing to say:
Task: what the user wants, and how that changed.
Instructions: what the user told the assistant to do or not do, their answers to its questions, and preferences they stated.
Environment: the machine and how it was reached (host, OS, shell, user), and facts found about it: addresses, devices, services, versions, config values, paths.
Changes: what was changed on the system (files, config, services, packages), with the exact commands, and any backups taken.
Commands: commands run and what came of them.
Tried and failed: approaches that did not work, and why.
State: where the work stands and what is left to do.
Keep hosts, addresses, paths, commands, config keys and error messages exact. Output only the summary.`;

/** What the model is sent of a Shell thread: the summary, then what follows it. */
export function shellModelThread(
	messages: ChatMessage[],
	compaction: CodeCompaction | null
): ChatMessage[] {
	return modelThread({ messages, compaction }, SHELL_SUMMARY_HEADER);
}

/**
 * Move the compaction's cut after the rendered thread was trimmed: messages
 * `[0, cutIdx)` were dropped and one note put in front of the rest. A summary
 * whose cut fell inside the dropped span now covers through the note.
 */
export function compactionAfterTrim(
	compaction: CodeCompaction | null,
	cutIdx: number
): CodeCompaction | null {
	if (!compaction) return null;
	return { ...compaction, at: Math.max(compaction.at - cutIdx, 0) + 1 };
}
