/**
 * The checks every camera tool makes before it touches a camera, in order:
 * any cameras at all, a model allowed to see and hear them (the local model,
 * or a server trusted in Settings → Cameras), a camera by that name, and the
 * camera's Ask / Allow permission.
 *
 * A job never gets an Ask camera. Jobs run with `approvalOverride` on, which
 * lets other tools skip their prompts; this gate doesn't read it, so the
 * user's Ask holds whatever the turn is.
 */

import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import type { BackendOverride } from '#lib/api.ts';
import type { ToolContext } from '#lib/agent/tools/types.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { cameraDataAllowed } from '#lib/camera/trust.ts';
import { askCameraUse, type CameraAction } from '#lib/stores/cameraApproval.svelte.ts';

export const NO_CAMERAS = 'No cameras are set up. Add one in Settings → Cameras.';
export const NOT_LOCAL =
	'Cameras only work with a model on this computer or a server trusted in Settings → Cameras.';
export const ASK_IN_JOB =
	"This camera is set to Ask, so jobs can't use it. Set it to Allow in Settings → Cameras.";
const CHAT_ONLY = 'Cameras work in Chat only.';

/** Whether a turn on `backend` may be offered the camera tools at all. */
export function camerasUsable(backend?: BackendOverride | null): boolean {
	return (
		getSettings().cameras.length > 0 &&
		cameraDataAllowed(resolveBackendDescriptor(backend ?? undefined))
	);
}

/**
 * The checks that need no camera name: cameras exist, this turn's model may
 * have their frames and sound, and the turn is a Chat one. Null when they
 * pass. `executeTool` runs this for every camera tool, offered or not.
 */
export function cameraAccessRefusal(
	ctx: Pick<ToolContext, 'backend' | 'codeMode' | 'shellMode' | 'subtask'>
): string | null {
	if (getSettings().cameras.length === 0) return NO_CAMERAS;
	if (!cameraDataAllowed(resolveBackendDescriptor(ctx.backend ?? undefined))) return NOT_LOCAL;
	if (ctx.codeMode || ctx.shellMode || ctx.subtask) return CHAT_ONLY;
	return null;
}

/** The camera the model named: by name, ignoring case and spaces at the ends, or by id. */
export function resolveCamera(
	name: unknown,
	cameras: readonly CameraConfig[] = getSettings().cameras
): CameraConfig | null {
	const wanted = String(name ?? '')
		.trim()
		.toLowerCase();
	if (!wanted) return null;
	return (
		cameras.find((c) => c.name.trim().toLowerCase() === wanted) ??
		cameras.find((c) => c.id === wanted) ??
		null
	);
}

/** The cameras' names, for a refusal that lists them. */
export function cameraNames(cameras: readonly CameraConfig[] = getSettings().cameras): string {
	return cameras.map((c) => `"${c.name}"`).join(', ');
}

export type CameraGate =
	| { camera: CameraConfig; refusal?: undefined; declined?: undefined }
	/** `declined`: the user said no to the prompt, which is an answer, not an error. */
	| { camera?: undefined; refusal: string; declined?: boolean };

/**
 * Run every check for using camera `name` to `action`. With someone there and
 * the camera on Ask, this asks and waits; a denial (or the turn stopping)
 * comes back as `declined`.
 */
export async function cameraGate(
	ctx: ToolContext,
	name: unknown,
	action: CameraAction
): Promise<CameraGate> {
	const access = cameraAccessRefusal(ctx);
	if (access) return { refusal: access };
	const camera = resolveCamera(name);
	if (!camera) {
		const asked = String(name ?? '').trim();
		return {
			refusal: `${asked ? `No camera is called "${asked}".` : 'Name a camera.'} The cameras are: ${cameraNames()}.`
		};
	}
	if (camera.permission === 'allow') return { camera };
	if (!ctx.interactive) return { refusal: ASK_IN_JOB };
	ctx.onApprovalWait?.(true);
	const choice = await askCameraUse(
		{
			cameras: [camera.name],
			action,
			chatId: ctx.conversationId ?? null,
			sessionId: ctx.codeSessionId ?? null
		},
		ctx.signal
	).finally(() => ctx.onApprovalWait?.(false));
	if (choice === 'deny') {
		return {
			declined: true,
			refusal: `The user declined. Nothing was taken from ${camera.name}; do not ask again unless they do.`
		};
	}
	return { camera };
}
