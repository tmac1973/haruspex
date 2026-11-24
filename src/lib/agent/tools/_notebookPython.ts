/**
 * Running a Python card an agent wrote or changed: once, through the same
 * approval prompt `run_python` uses (Settings → Chat → Approval prompt), so
 * the agent sees what its code did. A job's run doesn't ask; its job was
 * approved when it was written.
 */
import type { ToolContext } from '#lib/agent/tools/types.ts';
import { waitOnUser } from '#lib/agent/tools/_helpers.ts';
import * as api from '#lib/notebooks/api.ts';
import type { NotebookCard, NotebookSource } from '#lib/notebooks/api.ts';
import {
	pythonUnavailable,
	runPythonCard,
	sandboxIdFor,
	withOutput,
	type PythonOutput
} from '#lib/notebooks/pythonRun.ts';
import { formatSandboxResult } from '#lib/sandbox/formatResult.ts';
import {
	approveChatSandbox,
	askApproval,
	isChatSandboxApproved
} from '#lib/stores/sandboxApproval.svelte.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { errMessage } from '#lib/utils/error.ts';

/** Ask to run `code` when Settings say to; false when the user says no. */
async function approved(ctx: ToolContext, code: string, sandboxId: string): Promise<boolean> {
	const mode = getSettings().sandboxApproval;
	const ask =
		ctx.jobRunId === undefined &&
		(mode === 'every-run' || (mode === 'once-per-chat' && !isChatSandboxApproved(sandboxId)));
	if (!ask) return true;
	const choice = await waitOnUser(ctx, () =>
		askApproval({ code, mode, chatId: sandboxId }, ctx.signal)
	);
	if (choice === 'allow_chat') approveChatSandbox(sandboxId);
	return choice !== 'deny';
}

/** What a run says to the model. */
export function describeRun(out: PythonOutput): string {
	const text = formatSandboxResult({
		stdout: out.stdout,
		stderr: out.stderr,
		result: out.result,
		error: out.error,
		artifacts: out.artifacts.length,
		notes: out.notes,
		duration_ms: out.duration_ms
	});
	return out.result_csv
		? `${text}\n(\`result\` is a DataFrame; the user can save it as a table card.)`
		: text;
}

/**
 * Run a Python card and keep its output on it. Returns what to tell the
 * model: the output, or why it didn't run.
 */
export async function runCardForAgent(
	card: NotebookCard,
	ctx: ToolContext,
	source: NotebookSource
): Promise<string> {
	const why = pythonUnavailable();
	if (why) return `Saved, not run: ${why}`;
	try {
		if (!(await approved(ctx, card.body, sandboxIdFor(card.notebook_id)))) {
			return 'Saved, not run: the user declined to run it.';
		}
		const cards = (await api.getNotebook(card.notebook_id)).cards;
		const out = await runPythonCard(card, cards);
		await api.updateCard(card.id, card.version, { meta: withOutput(card, out) }, source);
		return describeRun(out);
	} catch (e) {
		return `Saved, but running it failed: ${errMessage(e)}`;
	}
}
