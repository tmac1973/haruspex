/**
 * Looking and listening through the cameras in Settings → Cameras.
 *
 * `camera_snapshot` is shaped like `capture_screen`: the frame goes onto
 * `ctx.pendingImages` for the model and back as `thumbDataUrl` for the user,
 * the same picture both ways. `camera_listen` records a short clip and has the
 * bundled whisper transcribe it; the clip itself is never kept.
 *
 * Every call goes through `_cameraGate.ts` first: a model on this computer or
 * a trusted server, a camera by that name, and its Ask / Allow permission.
 * While a camera is in use the header shows it (`cameraActivity`).
 */

import { invoke } from '@tauri-apps/api/core';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import type { CameraListenResult } from '#lib/ipc/gen/CameraListenResult.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolResult, toolError } from '#lib/agent/tools/types.ts';
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import { cameraAccessRefusal, cameraGate } from '#lib/agent/tools/_cameraGate.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { withCameraActivity } from '#lib/stores/cameraActivity.svelte.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import { redactCameraError } from '#lib/camera/credentials.ts';

/** Longest clip `camera_listen` records, matching the Rust command's cap. */
export const MAX_LISTEN_SECONDS = 30;
const DEFAULT_LISTEN_SECONDS = 10;
/** Below this, an empty transcript is reported as silence. */
const SILENCE_DB = -50;

const CAMERA_PARAM = {
	type: 'string',
	description: 'The camera\'s name, as camera_list gives it (e.g. "Kitchen").'
};

/** Whether the camera can be heard: a USB webcam needs a microphone picked, a stream an audio track. */
function hasAudio(camera: CameraConfig): boolean {
	if (camera.source.kind === 'usb' && !camera.source.audioDevice) return false;
	return camera.caps?.hasAudio !== false;
}

/** Local date and time, to the second: "2026-11-12 14:03:22". */
function stamp(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** A command's error as the model may see it: no address with a user name in it. */
function errorText(e: unknown): string {
	return redactCameraError(e instanceof Error ? e.message : String(e), '');
}

registerTool({
	category: 'camera',
	schema: {
		type: 'function',
		function: {
			name: 'camera_list',
			description:
				"List the user's cameras: name, kind (network or usb), whether it has sound, whether it can be aimed, and whether each use asks the user first.",
			parameters: { type: 'object', properties: {} }
		}
	},
	displayLabel: () => 'List cameras',
	async execute(_args, ctx) {
		const refusal = cameraAccessRefusal(ctx);
		if (refusal) return toolResult(toolError(refusal));
		const cameras = getSettings().cameras.map((c) => ({
			name: c.name,
			kind: c.source.kind === 'rtsp' ? 'network' : 'usb',
			has_audio: hasAudio(c),
			can_aim: c.ptz !== 'none',
			permission: c.permission
		}));
		return toolResult(JSON.stringify(cameras));
	}
});

registerTool({
	category: 'camera',
	requiresVision: true,
	schema: {
		type: 'function',
		function: {
			name: 'camera_snapshot',
			description:
				"Take one picture from one of the user's cameras so you can see it. The image is added to the conversation and you can describe it in your next response. Use it when the user asks what is happening somewhere a camera can see.",
			parameters: {
				type: 'object',
				properties: { camera: CAMERA_PARAM },
				required: ['camera']
			}
		}
	},
	displayLabel: (args) => `Look through ${String(args.camera ?? 'camera')}`,
	async execute(args, ctx) {
		if (ctx.visionSupported === false) {
			return toolResult(
				toolError('This model cannot see images, so it cannot use a camera picture.')
			);
		}
		if (ctx.pendingImages.length >= MAX_PENDING_IMAGES) {
			return toolResult(
				toolError(
					`Too many images pending (${ctx.pendingImages.length}). Answer about the images you already have before taking another.`
				)
			);
		}
		const gate = await cameraGate(ctx, args.camera, 'look');
		if (!gate.camera) return refused(gate);
		const camera = gate.camera;
		try {
			const dataUrl = await withCameraActivity(camera.id, 'look', () =>
				invoke<string>('camera_snapshot', { config: camera, overrides: videoOverrides() })
			);
			const when = stamp();
			ctx.pendingImages.push({ path: `camera:${camera.name} ${when}`, dataUrl });
			return {
				result: `Took a picture from ${camera.name} at ${when}. You can now see it — describe or analyze it in your next response.`,
				thumbDataUrl: dataUrl
			};
		} catch (e) {
			return toolResult(toolError(`${camera.name}: ${errorText(e)}`));
		}
	}
});

registerTool({
	category: 'camera',
	schema: {
		type: 'function',
		function: {
			name: 'camera_listen',
			description:
				"Record a few seconds of sound from one of the user's cameras and transcribe what was said. Returns the words and how loud it was. Use it when the user asks what is being said or heard somewhere.",
			parameters: {
				type: 'object',
				properties: {
					camera: CAMERA_PARAM,
					seconds: {
						type: 'integer',
						description: `How long to listen, 1 to ${MAX_LISTEN_SECONDS}. Defaults to ${DEFAULT_LISTEN_SECONDS}.`
					}
				},
				required: ['camera']
			}
		}
	},
	displayLabel: (args) => `Listen on ${String(args.camera ?? 'camera')}`,
	async execute(args, ctx) {
		const gate = await cameraGate(ctx, args.camera, 'listen');
		if (!gate.camera) return refused(gate);
		const camera = gate.camera;
		if (!hasAudio(camera)) {
			return toolResult(
				toolError(`${camera.name} has no microphone. Settings → Cameras sets one for a webcam.`)
			);
		}
		const seconds = listenSeconds(args.seconds);
		try {
			const heard = await withCameraActivity(camera.id, 'listen', () =>
				invoke<CameraListenResult>('camera_listen', {
					config: camera,
					seconds,
					transcribe: true,
					overrides: videoOverrides()
				})
			);
			return toolResult(describeHeard(camera.name, seconds, heard));
		} catch (e) {
			return toolResult(toolError(`${camera.name}: ${errorText(e)}`));
		}
	}
});

/** A refusal from the gate: the user's no as a plain answer, everything else as an error. */
function refused(gate: { refusal: string; declined?: boolean }) {
	return toolResult(gate.declined ? gate.refusal : toolError(gate.refusal));
}

/** The clip length the model asked for, whole seconds from 1 to `MAX_LISTEN_SECONDS`. */
export function listenSeconds(raw: unknown): number {
	const n = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isFinite(n) || raw === undefined || raw === null || raw === '') {
		return DEFAULT_LISTEN_SECONDS;
	}
	return Math.min(Math.max(Math.round(n), 1), MAX_LISTEN_SECONDS);
}

/** What the model is told a clip held. */
export function describeHeard(name: string, seconds: number, heard: CameraListenResult): string {
	const level = Math.round(heard.levelDb);
	const words = heard.transcript?.trim() ?? '';
	if (!words) {
		return heard.levelDb < SILENCE_DB
			? `Silence (level ${level} dB).`
			: `Sound but no words were made out over ${seconds} s on ${name} (level ${level} dB).`;
	}
	return `Heard on ${name} over ${seconds} s (level ${level} dB): ${words}`;
}
