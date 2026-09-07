/**
 * Screen capture, for questions about what is on it.
 *
 * The capture is deliberately shaped like `fs_read_image`: the picture is
 * pushed onto `ctx.pendingImages` so the model sees it on its next turn, and
 * returned as `thumbDataUrl` so the user sees exactly what was sent. Those two
 * are the same image, which is the point — there is no version of this where
 * something goes to the model that the person did not also get to look at.
 */

import { invoke } from '@tauri-apps/api/core';
import { IPC } from '$lib/ipc/commands';
import type { ScreenCapture } from '$lib/ipc/gen/ScreenCapture';
import type { CaptureTarget } from '$lib/ipc/gen/CaptureTarget';
import { registerTool } from './registry';
import { toolResult, toolError } from './types';
import { MAX_PENDING_IMAGES } from './fs-read';

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
		try {
			const capture = await invoke<ScreenCapture>(IPC.capture_screen, { target });
			ctx.pendingImages.push({ path: `screen capture (${target})`, dataUrl: capture.dataUrl });
			return {
				result: `Captured the ${target} at ${capture.width}x${capture.height}. You can now see it — describe or analyze it in your next response.`,
				thumbDataUrl: capture.dataUrl
			};
		} catch (e) {
			// The backend's messages name the actual obstacle — a cancelled
			// portal dialog, a missing macOS grant — so they are passed through
			// rather than flattened into "capture failed".
			return toolResult(toolError(String(e)));
		}
	}
});
