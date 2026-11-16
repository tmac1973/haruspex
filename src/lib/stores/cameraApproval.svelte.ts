/**
 * Approval prompt for the camera tools. Same pattern as
 * screenCaptureApproval.svelte.ts: a camera tool calls `askCameraUse` before
 * it touches a camera set to Ask (Settings → Cameras), the modal mounted in
 * the root layout shows the request, and the user's choice resolves it.
 *
 * Every camera tool asks through this one prompt, so the four actions
 * (`#lib/camera/useQuestion.ts`) are defined before each has a tool.
 *
 * Prompts queue (`approvalQueue.svelte.ts`), one shown at a time. The remote
 * page (Settings → Remote control) answers it too, through `engine/prompts`.
 */

import { createApprovalQueue } from '#lib/stores/approvalQueue.svelte.ts';
import { cameraUseQuestion, type CameraAction } from '#lib/camera/useQuestion.ts';

export type { CameraAction };
export { cameraUseQuestion };

export interface CameraUseRequest {
	/** The cameras' names, as Settings → Cameras shows them. */
	cameras: string[];
	action: CameraAction;
	/** The chat or Code session whose turn asks, so the remote page shows it there. */
	chatId?: string | null;
	sessionId?: string | null;
}

export type CameraUseChoice = 'allow' | 'deny';

const queue = createApprovalQueue<CameraUseRequest, CameraUseChoice>();

/**
 * Ask before a camera is used. Waits behind any prompt already showing;
 * stopping the turn withdraws it as a denial.
 */
export function askCameraUse(
	request: CameraUseRequest,
	signal?: AbortSignal
): Promise<CameraUseChoice> {
	return queue.ask(request, { signal, abortResult: 'deny' });
}

export function getPendingCameraUse(): CameraUseRequest | null {
	return queue.current();
}

export function resolveCameraUse(choice: CameraUseChoice): void {
	queue.resolve(choice);
}
