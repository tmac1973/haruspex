/**
 * The exact text of tool results the context fit took out of the prompt, for
 * the `recall_result` tool to hand back.
 *
 * A trimmed result used to be gone for the rest of the turn: the stub told the
 * model to call the tool again, which is not the same thing. Shell output and
 * web pages change, a command with side effects should not run twice, and a
 * long test run costs minutes. The text was still in memory all along — the
 * fit swaps in a new message object — so this keeps it where the model can
 * reach it (#1022).
 *
 * One archive per agent loop, and only for a loop that offers `recall_result`: the
 * ids mean nothing to the next turn, which re-sends or re-reads its own.
 */

import type { ChatMessage, ToolDefinition } from '#lib/api.ts';
import { receiptFor } from '#lib/agent/receipt.ts';
import { callFor } from '#lib/agent/toolRounds.ts';

/** The name the recall tool registers under. */
export const RECALL_TOOL = 'recall_result';

/** One archived result. */
export interface ArchivedResult {
	id: string;
	/** The call that produced it, as the stub names it: `run_command(npm test)`. */
	call: string;
	text: string;
}

export class RecallArchive {
	private readonly byId = new Map<string, ArchivedResult>();
	private readonly idByCall = new Map<string, string>();
	/**
	 * The most this tool round's recalls may hand back, in estimated tokens
	 * (`estimateTokens`, uncalibrated), and how much they have. A round that
	 * recalls more than the window has room for is trimmed again before the
	 * model reads it: in a live run six parallel recalls took the prompt to
	 * 98% and the next call stubbed them all, for a re-read that bought
	 * nothing (#1022).
	 */
	private roundTokens = Infinity;
	private roundUsed = 0;

	/**
	 * Keep `text`, the full result of tool call `toolCallId`, and return the id
	 * to put in its stub. A result already kept — cut first, stubbed later —
	 * keeps its id and its first, whole text.
	 */
	keep(toolCallId: string, call: string, text: string): string {
		const known = this.idByCall.get(toolCallId);
		if (known) return known;
		const id = `r${this.byId.size + 1}`;
		this.byId.set(id, { id, call, text });
		this.idByCall.set(toolCallId, id);
		return id;
	}

	get(id: string): ArchivedResult | undefined {
		return this.byId.get(id.trim());
	}

	get size(): number {
		return this.byId.size;
	}

	/** A new tool round, whose recalls have `roomTokens` between them. */
	startRound(roomTokens = Infinity): void {
		this.roundTokens = roomTokens;
		this.roundUsed = 0;
	}

	/** Estimated tokens this round's recalls may still hand back. */
	get roomLeft(): number {
		return Math.max(0, this.roundTokens - this.roundUsed);
	}

	/** Whether a recall has handed anything back this round. */
	get recalledThisRound(): boolean {
		return this.roundUsed > 0;
	}

	/** Count `tokens` of recalled text against this round. */
	spend(tokens: number): void {
		this.roundUsed += tokens;
	}
}

/** An archive for a turn that offers `recall_result`; none otherwise. */
export function archiveFor(tools: ToolDefinition[]): RecallArchive | undefined {
	return tools.some((t) => t.function.name === RECALL_TOOL) ? new RecallArchive() : undefined;
}

/**
 * Whether the result at `message` should be archived before it is cut: a tool
 * result with a call id, that is not itself a `recall_result` reply (that text is in
 * the archive already, under the id the model asked for).
 */
export function archivable(
	message: ChatMessage,
	toolName: string
): message is ChatMessage & {
	tool_call_id: string;
} {
	return message.role === 'tool' && !!message.tool_call_id && toolName !== RECALL_TOOL;
}

/**
 * Archive the tool result at `idx` before the fit cuts it, and return its id;
 * null when there is no archive or the result is not one to keep. `text` is
 * the result as it stands, `call` the stub's name for its call.
 */
export function keepResult(
	archive: RecallArchive | undefined,
	messages: ChatMessage[],
	idx: number,
	text: string,
	call: string
): string | null {
	const message = messages[idx];
	const name = callFor(messages, idx)?.function.name ?? '';
	if (!archive || !archivable(message, name)) return null;
	return archive.keep(message.tool_call_id, call, text);
}

/** The stub for an archived result: its receipt, and how to get it back. */
export function archivedStub(archive: RecallArchive, id: string): string {
	const kept = archive.get(id)!;
	return (
		`[Trimmed to free context: the result of ${kept.call || 'an earlier tool call'}. ` +
		`${receiptFor(kept.text)} Trimming says nothing about what it contained. ` +
		`Exact text: recall_result id="${id}".]`
	);
}

/** The hint at the cut in a result the fit shortened. */
export function recallHint(id: string): string {
	return `Exact full text: recall_result id="${id}".`;
}
