/**
 * One Chat conversation's turn state: whether a turn runs, waits for the
 * model or for the server to start, what it has streamed so far, and how the
 * last one failed. Each conversation has its own, so turns in different
 * conversations run side by side, each with its own Stop and error banner.
 *
 * Display and control only: the conversation's messages and steps live on
 * the `Conversation` in the chat store.
 */

import type { SteeringMessage } from '#lib/agent/loop.ts';

export class ChatRun {
	/**
	 * Messages sent while the turn runs, given to the model at its next step.
	 * See `AgentLoopOptions.takeSteering`.
	 */
	steering = $state<SteeringMessage[]>([]);
	/**
	 * Steering the turn ended without delivering (stopped, or typed after
	 * its last step), for the input box to take back.
	 */
	returnedText = $state<string[]>([]);
	returnedImages = $state<string[]>([]);
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

	/** Queue a message for the running turn's next step. */
	steer(message: SteeringMessage): void {
		this.steering = [...this.steering, message];
	}

	/** Take the queue, for the loop to deliver. */
	takeSteering(): SteeringMessage[] {
		const steers = this.steering;
		this.steering = [];
		return steers;
	}

	/** Give steering the model never saw back to the input box. */
	handBack(steers: SteeringMessage[]): void {
		for (const m of steers) {
			if (m.text) this.returnedText = [...this.returnedText, m.text];
			if (m.images?.length) this.returnedImages = [...this.returnedImages, ...m.images];
		}
	}

	/** Take what was handed back, clearing it. */
	takeReturned(): { text: string[]; images: string[] } {
		const out = { text: this.returnedText, images: this.returnedImages };
		this.returnedText = [];
		this.returnedImages = [];
		return out;
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
