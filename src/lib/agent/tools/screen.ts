/**
 * Screen capture, for questions about what is on it.
 *
 * The capture is deliberately shaped like `fs_read_image`: the picture is
 * pushed onto `ctx.pendingImages` so the model sees it on its next turn, and
 * returned as `thumbDataUrl` so the user sees exactly what was sent. Those two
 * are the same image, which is the point — there is no version of this where
 * something goes to the model that the person did not also get to look at.
 *
 * It takes the picture the way the composer's camera button does: no desktop
 * dialog, with Haruspex hidden so the screen or window behind it is what is
 * captured. Haruspex's own prompt asks first, unless Settings → Screen says not to.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ScreenCapture } from '#lib/ipc/gen/ScreenCapture.ts';
import type { CaptureTarget } from '#lib/ipc/gen/CaptureTarget.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolResult, toolError } from '#lib/agent/tools/types.ts';
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { askScreenCapture } from '#lib/stores/screenCaptureApproval.svelte.ts';
import { hideSettled, withHaruspexHidden } from '#lib/shell/captureRegion.ts';

/**
 * Normalize whatever the model wrote into a target the backend knows.
 *
 * Models write "active window", "the current window", "fullscreen" and
 * "desktop" as often as the two words the schema lists, and rejecting those
 * would spend a turn on a spelling correction. Anything unrecognised falls
 * back to the whole screen, which is the safer of the two to guess wrong.
 */
export function normalizeTarget(raw: unknown): CaptureTarget {
	const value = String(raw ?? '')
		.trim()
		.toLowerCase();
	if (value.includes('window')) return 'window';
	return 'screen';
}

registerTool({
	category: 'desktop',
	requiresVision: true,
	schema: {
		type: 'function',
		function: {
			name: 'capture_screen',
			description:
				"Take a screenshot of the user's display so you can see it. The image is added to the conversation and you can describe it or answer questions about it in your next response. Use this when the user asks about something on their screen. It captures once, when you call it — there is no way to watch the screen or capture repeatedly.",
			parameters: {
				type: 'object',
				properties: {
					target: {
						type: 'string',
						enum: ['screen', 'window'],
						description:
							'"screen" for the whole display, "window" for the window the user is currently working in. Defaults to the whole screen.'
					}
				}
			}
		}
	},
	displayLabel: (args) =>
		normalizeTarget(args.target) === 'window' ? 'Capture window' : 'Capture screen',
	async execute(args, ctx) {
		if (ctx.pendingImages.length >= MAX_PENDING_IMAGES) {
			return toolResult(
				toolError(
					`Too many images pending (${ctx.pendingImages.length}). Answer about the images you already have before capturing another — loading too many in one turn exhausts the model context.`
				)
			);
		}
		const target = normalizeTarget(args.target);
		if (getSettings().screenCaptureConfirm) {
			if (!ctx.interactive) {
				return toolResult(
					toolError(
						'Screenshots need the user to confirm each one, and nobody is here to. The user can stop the question in Settings → Screen.'
					)
				);
			}
			ctx.onApprovalWait?.(true);
			const choice = await askScreenCapture(
				{
					target,
					chatId: ctx.conversationId ?? null,
					sessionId: ctx.codeSessionId ?? null
				},
				ctx.signal
			).finally(() => ctx.onApprovalWait?.(false));
			if (choice === 'deny') {
				return toolResult(
					'The user declined the screenshot. Nothing was captured; do not ask for another unless they do.'
				);
			}
		}
		try {
			const capture = await withHaruspexHidden(async () => {
				await hideSettled();
				return invoke<ScreenCapture>('capture_screen', { target });
			});
			const took = capture.target;
			ctx.pendingImages.push({ path: `screen capture (${took})`, dataUrl: capture.dataUrl });
			const note =
				took === target
					? ''
					: ' The window could not be captured on its own here, so this is the whole screen.';
			return {
				result: `Captured the ${took} at ${capture.width}x${capture.height}.${note} You can now see it — describe or analyze it in your next response.`,
				thumbDataUrl: capture.dataUrl
			};
		} catch (e) {
			// The backend's messages name the actual obstacle — a refused
			// desktop permission, a missing macOS grant — so they are passed
			// through rather than flattened into "capture failed".
			return toolResult(toolError(String(e)));
		}
	}
});
