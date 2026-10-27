/**
 * Approval prompt for `capture_screen`. Same pattern as
 * memoryApproval.svelte.ts: the tool calls `askScreenCapture` before taking
 * the screenshot, the modal mounted in the root layout shows the request, and
 * the user's choice resolves it.
 *
 * Asked about because nothing else is: the capture skips the desktop's own
 * dialog, so without this the first the user sees of a screenshot is the
 * thumbnail of one already sent. Settings → Screen turns it off.
 *
 * Prompts queue (`approvalQueue.svelte.ts`), one shown at a time. The remote
 * page (Settings → Remote control) answers it too, through `engine/prompts`.
 */

import { createApprovalQueue } from '#lib/stores/approvalQueue.svelte.ts';
import type { CaptureTarget } from '#lib/ipc/gen/CaptureTarget.ts';

export interface ScreenCaptureRequest {
	target: CaptureTarget;
	/** The chat or Code session whose turn asks, so the remote page shows it there. */
	chatId: string | null;
	sessionId: string | null;
}

export type ScreenCaptureChoice = 'allow' | 'deny';

const queue = createApprovalQueue<ScreenCaptureRequest, ScreenCaptureChoice>();

/**
 * Ask before a screenshot. Waits behind any prompt already showing; stopping
 * the turn withdraws it as a denial.
 */
export function askScreenCapture(
	request: ScreenCaptureRequest,
	signal?: AbortSignal
): Promise<ScreenCaptureChoice> {
	return queue.ask(request, { signal, abortResult: 'deny' });
}

export function getPendingScreenCapture(): ScreenCaptureRequest | null {
	return queue.current();
}

export function resolveScreenCapture(choice: ScreenCaptureChoice): void {
	queue.resolve(choice);
}
