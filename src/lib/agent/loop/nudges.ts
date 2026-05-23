/**
 * Per-turn recovery state for `runAgentLoop`. Tracks the nudge
 * heuristics that catch common small-model failure modes:
 *
 *  1. **File-write hallucination**: the user asked for a file (PDF,
 *     DOCX, etc.) and the model finished its turn without actually
 *     calling an fs_write_* tool. We push a corrective user message
 *     and re-enter the loop, up to MAX_FILE_WRITE_RETRIES times.
 *
 *  2. **Diversity gate**: the model ran web_search but only opened
 *     one page (or none). Answers in this shape reliably collapse
 *     every citation to the same URL. One nudge per turn asks the
 *     model to fetch 2–3 more distinct pages.
 *
 *  3. **run_python failure streak**: 3+ consecutive run_python
 *     results starting with "Error:" → append a "step back and
 *     re-evaluate" hint to the tool result so the model can break
 *     out of a tight-loop of near-identical failing code.
 *
 *  4. **Narrate-recovery**: after any nudge that demands a tool
 *     call, smaller models often reply with text describing what
 *     they will do next ("Let me fetch these...") and emit no
 *     tool_calls block. The loop would then commit that narration
 *     as the final answer. Arming this flag with armNarrateRecovery
 *     after pushing a nudge gives runAgentLoop one shot to detect
 *     narrate-mode and force the action.
 *
 * NudgeState owns all the counters plus their consumed flags so
 * runAgentLoop reads as `if (nudges.needsX()) {…}` instead of
 * inspecting raw booleans scattered through 600 lines.
 */

export const MAX_FILE_WRITE_RETRIES = 2;
export const RUN_PYTHON_FAILURE_NUDGE_THRESHOLD = 3;

export class NudgeState {
	/** Set to true the first time any fs_write_* tool returns success. */
	private fileWritten = false;
	/** Bounded retry counter for the file-write hallucination nudge. */
	private fileWriteRetries = 0;
	/** Set to true on the first web_search tool call this turn. */
	private webSearchUsed = false;
	/** Distinct URLs fetched via fetch_url / research_url this turn. */
	private fetchedUrls: Set<string> = new Set();
	/** Have we already pushed the diversity nudge this turn? */
	private diversityNudged = false;
	/** Consecutive `run_python` results that began with "Error:". */
	private consecutiveRunPythonFailures = 0;
	/**
	 * Armed by armNarrateRecovery after any nudge that demanded a tool
	 * call. Cleared by consumeNarrateRecovery on either the recovery
	 * firing or the model self-correcting with real tool_calls.
	 */
	private pendingNarrateRecovery = false;

	/** Record that an fs_write_* call landed on disk. */
	markFileWritten(): void {
		this.fileWritten = true;
	}

	/** Record that web_search was invoked. */
	markWebSearchUsed(): void {
		this.webSearchUsed = true;
	}

	/** Record a successful fetch_url / research_url call by URL. */
	recordFetchedUrl(url: string): void {
		this.fetchedUrls.add(url);
	}

	/**
	 * Should we push the file-write hallucination nudge? Caller still
	 * applies the "is this a clarifying question?" check because that
	 * needs `response.content` which isn't NudgeState's business.
	 */
	needsFileWriteNudge(expectsFileOutput: boolean): boolean {
		return expectsFileOutput && !this.fileWritten && this.fileWriteRetries < MAX_FILE_WRITE_RETRIES;
	}

	/** Increment the retry counter; call when emitting the nudge. */
	consumeFileWriteNudge(): void {
		this.fileWriteRetries++;
	}

	/** Read back the current retry counter for log lines. */
	get fileWriteRetryCount(): number {
		return this.fileWriteRetries;
	}

	/**
	 * Should we push the diversity nudge? Called when the model has
	 * finished tool calls and is about to synthesize. Guards: a
	 * web_search must have happened, ≤1 page was fetched, and we
	 * haven't already nudged this turn.
	 */
	needsDiversityNudge(usedTools: boolean): boolean {
		return usedTools && this.webSearchUsed && this.fetchedUrls.size <= 1 && !this.diversityNudged;
	}

	/** Mark the diversity nudge as fired; returns the fetched count. */
	consumeDiversityNudge(): number {
		this.diversityNudged = true;
		return this.fetchedUrls.size;
	}

	/**
	 * Arm the narrate-recovery flag. Call this whenever a nudge pushes
	 * a corrective user message that demands a tool call — if the next
	 * iteration comes back with no tool_calls, the loop will force
	 * action instead of committing the narration as a final answer.
	 */
	armNarrateRecovery(): void {
		this.pendingNarrateRecovery = true;
	}

	/** Is narrate-recovery armed? */
	needsNarrateRecovery(): boolean {
		return this.pendingNarrateRecovery;
	}

	/**
	 * Clear the narrate-recovery flag. Called both when the recovery
	 * fires and when the model self-corrects by emitting tool_calls.
	 */
	consumeNarrateRecovery(): void {
		this.pendingNarrateRecovery = false;
	}

	/**
	 * Process a `run_python` result: increment the failure streak on
	 * `Error:` results, reset it on success. Returns either the input
	 * `result` unchanged or `result + hint` once the streak has crossed
	 * RUN_PYTHON_FAILURE_NUDGE_THRESHOLD, so the caller can append the
	 * returned string directly to the tool message.
	 */
	maybeAppendRunPythonHint(result: string): string {
		if (result.startsWith('Error:')) {
			this.consecutiveRunPythonFailures++;
			if (this.consecutiveRunPythonFailures >= RUN_PYTHON_FAILURE_NUDGE_THRESHOLD) {
				return (
					result +
					`\n\n[Haruspex hint] This is your ${this.consecutiveRunPythonFailures}th consecutive run_python failure in this turn. ` +
					'Stop and re-evaluate before retrying — do not just resubmit a variation of the same code. ' +
					'Verify your assumptions about the inputs you are working with, or try a fundamentally different approach.'
				);
			}
		} else {
			this.consecutiveRunPythonFailures = 0;
		}
		return result;
	}
}
