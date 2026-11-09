/**
 * The contract between a module run and the sandboxed frame it runs in. The
 * host supplies the frame: the app's is `runHiddenFrame`
 * (`#lib/sandbox/hiddenFrame.ts`), on the `haruspex-artifact:` scheme; a host
 * outside the app brings its own. Nothing here touches the DOM or Tauri.
 */

/** What a run's message handler can do with its frame. */
export interface FrameControl {
	/** Post a message into the page. */
	post(message: unknown): void;
	/** Call `fn` after `ms`, unless the run has ended. */
	later(ms: number, fn: () => void): void;
	/** Stop the overall timeout (every awaited message is in). */
	clearDeadline(): void;
	/** End the run: remove the frame and resolve. */
	done(): void;
}

export interface FrameOptions {
	signal?: AbortSignal;
	timeoutMs: number;
	/** The overall timeout passed; the handler records it and calls `done`. */
	onTimeout(ctl: FrameControl): void;
	/** A message from the page (an object; anything else is dropped). */
	onMessage(data: Record<string, unknown>, ctl: FrameControl): void;
}

/**
 * Run model-written HTML in a sandboxed frame that reaches neither the host
 * nor the network. Resolves when the handler calls `done`; rejects with an
 * `AbortError` when `signal` aborts.
 */
export type FrameRunner = (html: string, opts: FrameOptions) => Promise<void>;

export interface RunError {
	kind: 'error' | 'rejection' | 'console' | 'no-export' | 'timeout';
	message: string;
	/** The line in the original HTML, when the browser reports one. */
	line: number | null;
}

/** Time after the last awaited message, to collect late errors. */
export const LATE_MS = 500;
