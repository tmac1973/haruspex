/**
 * One Chat conversation's turn state: whether a turn runs, waits for the
 * model or for the server to start, what it has streamed so far, and how the
 * last one failed. Each conversation has its own, so turns in different
 * conversations run side by side, each with its own Stop and error banner.
 *
 * Display and control only: the conversation's messages and steps live on
 * the `Conversation` in the chat store.
 */

export class ChatRun {
	/** A turn is running, or waiting for an inference slot. */
	generating = $state(false);
	/** The turn is waiting for an inference slot. */
	waitingForSlot = $state(false);
	/** The user's message waits for llama-server to finish starting. */
	queuedForStartup = $state(false);
	compacting = $state(false);
	/** The answer so far. */
	streamingContent = $state('');
	/**
	 * Set when the pre-send guard had to reduce history to fit the model's
	 * context window. Shown inline in the thread, cleared at the next turn.
	 */
	contextNotice = $state<string | null>(null);
	errorMessage = $state<string | null>(null);
	/**
	 * Turn id of the agent run that produced the error, for the "copy debug
	 * log for this failure" button.
	 */
	errorTurnId = $state<number | null>(null);
	/**
	 * The last turn ended in a retryable failure. The user message is already
	 * in history, so a retry just re-runs the turn against it.
	 */
	lastTurnFailed = $state(false);

	currentTurnId: number | null = null;
	abortController: AbortController | null = null;

	/** Anything in flight: a turn, a queued send, or a summary being made. */
	get busy(): boolean {
		return this.generating || this.queuedForStartup || this.compacting;
	}

	clearError(): void {
		this.errorMessage = null;
		this.errorTurnId = null;
		this.lastTurnFailed = false;
	}

	/** Start a turn: fresh stream, no error, a new abort controller. */
	begin(turnId: number): AbortSignal {
		this.generating = true;
		this.streamingContent = '';
		this.clearError();
		this.currentTurnId = turnId;
		this.abortController = new AbortController();
		return this.abortController.signal;
	}

	/** Record a failure the user can retry. */
	fail(message: string, turnId: number | null): void {
		this.errorMessage = message;
		this.errorTurnId = turnId;
		this.lastTurnFailed = true;
	}

	/**
	 * End the turn that owns `signal`. A turn cancelled and replaced while it
	 * was still unwinding must not clear the new turn's state.
	 */
	end(signal: AbortSignal): void {
		if (this.abortController !== null && this.abortController.signal !== signal) return;
		this.generating = false;
		this.waitingForSlot = false;
		this.streamingContent = '';
		this.abortController = null;
	}

	/**
	 * Stop whatever is in flight. A send queued for startup is unqueued and
	 * left as a retryable failure: its message is already in history.
	 */
	cancel(): void {
		if (this.queuedForStartup) {
			this.queuedForStartup = false;
			this.fail('Cancelled before the model started.', null);
			return;
		}
		this.abortController?.abort();
		this.abortController = null;
		this.generating = false;
		this.waitingForSlot = false;
	}
}
