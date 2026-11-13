/**
 * Looking and listening through the cameras in Settings → Cameras.
 *
 * `camera_snapshot` is shaped like `capture_screen`: the frame goes onto
 * `ctx.pendingImages` for the model and back as `thumbDataUrl` for the user,
 * the same picture both ways. `camera_listen` records a short clip and has the
 * bundled whisper transcribe it; the clip itself is never kept.
 *
 * `camera_look` aims a pan/tilt camera (ONVIF, or UVC on Linux) by a
 * direction or a saved preset, then takes a picture like `camera_snapshot`.
 *
 * `camera_log` (in `camera-log.ts`) reads the ambient log.
 *
 * Every call goes through `_cameraGate.ts` first: a model on this computer or
 * a trusted server, a camera by that name, and its Ask / Allow permission.
 * While a camera is in use the header shows it (`cameraActivity`).
 */

import { invoke } from '@tauri-apps/api/core';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import type { CameraListenResult } from '#lib/ipc/gen/CameraListenResult.ts';
import type { Aim } from '#lib/ipc/gen/Aim.ts';
import type { AimAmount } from '#lib/ipc/gen/AimAmount.ts';
import type { AimDirection } from '#lib/ipc/gen/AimDirection.ts';
import type { CameraAimResult } from '#lib/ipc/gen/CameraAimResult.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolResult, toolError } from '#lib/agent/tools/types.ts';
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import { cameraAccessRefusal, cameraGate, resolveCamera } from '#lib/agent/tools/_cameraGate.ts';
import { stamp } from '#lib/camera/log.ts';
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

/** Whether the camera can be aimed: ONVIF found over the network, or a UVC webcam. */
export function canAim(camera: CameraConfig): boolean {
	if (camera.ptz === 'onvif') return camera.source.kind === 'rtsp' && !!camera.onvif;
	if (camera.ptz === 'uvc') return camera.source.kind === 'usb';
	return false;
}

/** A command's error as the model may see it: no address with a user name in it. */
export function errorText(e: unknown): string {
	return redactCameraError(e instanceof Error ? e.message : String(e), '');
}

registerTool({
	category: 'camera',
	schema: {
		type: 'function',
		function: {
			name: 'camera_list',
			description:
				"List the user's cameras: name, kind (network or usb), whether it has sound, whether it can be aimed (and its saved presets), and whether each use asks the user first.",
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
			can_aim: canAim(c),
			...(canAim(c) && c.ptz === 'onvif'
				? { presets: (c.onvif?.presets ?? []).map((p) => p.name) }
				: {}),
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

export const CANT_MOVE = "This camera can't move.";
export const DIRECTION_OR_PRESET = 'Give a direction or a preset.';
const DIRECTIONS: readonly AimDirection[] = ['left', 'right', 'up', 'down', 'home'];
const AMOUNTS: readonly AimAmount[] = ['small', 'medium', 'large'];
/** Roughly how far each amount turns, for the model's answer: pan / tilt degrees. */
const DEGREES: Record<AimAmount, [number, number]> = {
	small: [10, 10],
	medium: [30, 20],
	large: [60, 40]
};

/** The aim the model asked for, or why it can't be read. */
export function parseAim(args: Record<string, unknown>): Aim | { error: string } {
	const has = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';
	const direction = has(args.direction) ? String(args.direction).trim().toLowerCase() : '';
	const preset = has(args.preset) ? String(args.preset).trim() : '';
	if (!direction === !preset) return { error: DIRECTION_OR_PRESET };
	if (preset) return { preset };
	if (!DIRECTIONS.includes(direction as AimDirection)) {
		return { error: `Direction must be one of ${DIRECTIONS.join(', ')}.` };
	}
	const rawAmount = has(args.amount) ? String(args.amount).trim().toLowerCase() : 'medium';
	if (!AMOUNTS.includes(rawAmount as AimAmount)) {
		return { error: `Amount must be one of ${AMOUNTS.join(', ')}.` };
	}
	return { direction: direction as AimDirection, amount: rawAmount as AimAmount };
}

/** What the model is told the camera did: "Turned Kitchen left about 30°". */
export function describeAim(name: string, aim: Aim, atLimit: boolean, unmoved = false): string {
	if ('preset' in aim) return `Moved ${name} to the preset "${aim.preset}"`;
	if (aim.direction === 'home') return `Moved ${name} back to its home position`;
	if (unmoved) {
		return `Tried to turn ${name} ${aim.direction}, but its picture didn't change: it is already as far as it goes that way`;
	}
	const [pan, tilt] = DEGREES[aim.amount];
	const degrees = aim.direction === 'left' || aim.direction === 'right' ? pan : tilt;
	const turned = `Turned ${name} ${aim.direction} about ${degrees}°`;
	return atLimit ? `${turned}, as far as it goes that way` : turned;
}

registerTool({
	category: 'camera',
	schema: {
		type: 'function',
		function: {
			name: 'camera_look',
			description:
				"Turn (pan or tilt) one of the user's pan/tilt cameras, then take a picture so you can see where it points. It is the only tool that moves a camera. Give either a direction (with an amount) or the name of a preset saved on the camera, not both. Use it when the user asks to look somewhere the camera isn't pointing.",
			parameters: {
				type: 'object',
				properties: {
					camera: CAMERA_PARAM,
					direction: {
						type: 'string',
						enum: [...DIRECTIONS],
						description: 'Which way to turn; home points it back to the middle.'
					},
					amount: {
						type: 'string',
						enum: [...AMOUNTS],
						description:
							'How far: small is about 10°, medium about 30° (20° up or down), large about 60° (40° up or down). Defaults to medium.'
					},
					preset: {
						type: 'string',
						description: 'A position saved on the camera, by name, as camera_list gives it.'
					}
				},
				required: ['camera']
			}
		}
	},
	displayLabel: (args) => `Turn ${String(args.camera ?? 'camera')}`,
	async execute(args, ctx) {
		const aim = parseAim(args);
		if ('error' in aim) return toolResult(toolError(aim.error));
		// Refused before asking: no point prompting the user for a camera that can't turn.
		const access = cameraAccessRefusal(ctx);
		const named = access ? null : resolveCamera(args.camera);
		if (named && !canAim(named)) return toolResult(toolError(CANT_MOVE));
		const gate = await cameraGate(ctx, args.camera, 'move');
		if (!gate.camera) return refused(gate);
		const camera = gate.camera;
		const canSee = ctx.visionSupported !== false && ctx.pendingImages.length < MAX_PENDING_IMAGES;
		let outcome: { moved: CameraAimResult; dataUrl: string | null; shotError: string };
		try {
			outcome = await withCameraActivity(camera.id, 'move', async () => {
				const moved = await aimCamera(camera, aim);
				if (!canSee) return { moved, dataUrl: null, shotError: '' };
				try {
					return { moved, dataUrl: await shoot(camera), shotError: '' };
				} catch (e) {
					return { moved, dataUrl: null, shotError: errorText(e) };
				}
			});
		} catch (e) {
			return toolResult(toolError(`${camera.name}: ${errorText(e)}`));
		}
		const { dataUrl, shotError } = outcome;
		const did = describeAim(camera.name, aim, outcome.moved.atLimit, outcome.moved.unmoved);
		if (ctx.visionSupported === false) {
			return toolResult(`${did}. This model cannot see images, so no picture was taken.`);
		}
		if (!dataUrl) {
			return toolResult(
				shotError
					? `${did}, but the picture failed: ${shotError}`
					: `${did}. Too many images are pending (${ctx.pendingImages.length}), so no picture was taken; answer about the images you already have first.`
			);
		}
		const when = stamp();
		ctx.pendingImages.push({ path: `camera:${camera.name} ${when}`, dataUrl });
		return {
			result: `${did} and took a picture at ${when}. You can now see it — describe or analyze it in your next response.`,
			thumbDataUrl: dataUrl
		};
	}
});

function aimCamera(camera: CameraConfig, aim: Aim): Promise<CameraAimResult> {
	return invoke<CameraAimResult>('camera_aim', {
		config: camera,
		aim,
		overrides: videoOverrides()
	});
}

function shoot(camera: CameraConfig): Promise<string> {
	return invoke<string>('camera_snapshot', { config: camera, overrides: videoOverrides() });
}

/** The most turns a sweep makes to reach either end. */
export const SWEEP_MAX_TURNS = 8;
const SWEEP_STEP: Aim = { direction: 'right', amount: 'large' };

export interface Sweep {
	/** Pictures, leftmost first. */
	shots: string[];
	/** Whether it found the end of the camera's travel on each side. */
	leftEnd: boolean;
	rightEnd: boolean;
}

/**
 * Turn the camera to its far left, then right a large step at a time taking a
 * picture at each stop, until it goes no further or `room` pictures are taken;
 * then send it home. A turn that leaves the picture unchanged takes none.
 */
export async function runSweep(
	aim: (a: Aim) => Promise<CameraAimResult>,
	take: () => Promise<string>,
	room: number
): Promise<Sweep> {
	let leftEnd = false;
	for (let i = 0; i < SWEEP_MAX_TURNS && !leftEnd; i++) {
		leftEnd = (await aim({ direction: 'left', amount: 'large' })).atLimit;
	}
	const shots = [await take()];
	let rightEnd = false;
	for (let i = 0; i < SWEEP_MAX_TURNS && shots.length < room && !rightEnd; i++) {
		const moved = await aim(SWEEP_STEP);
		rightEnd = moved.atLimit;
		if (!moved.unmoved) shots.push(await take());
	}
	await aim({ direction: 'home', amount: 'medium' });
	return { shots, leftEnd, rightEnd };
}

registerTool({
	category: 'camera',
	requiresVision: true,
	schema: {
		type: 'function',
		function: {
			name: 'camera_look_around',
			description:
				"Sweep one of the user's pan/tilt cameras across its whole range, left to right, taking a picture at each stop, then point it back home. Use it when the user asks to look around, scan or survey the room. It keeps the camera's tilt: turn it up or down with camera_look first if needed. Takes up to a minute.",
			parameters: {
				type: 'object',
				properties: { camera: CAMERA_PARAM },
				required: ['camera']
			}
		}
	},
	displayLabel: (args) => `Look around with ${String(args.camera ?? 'camera')}`,
	async execute(args, ctx) {
		if (ctx.visionSupported === false) {
			return toolResult(
				toolError('This model cannot see images, so it cannot use a camera picture.')
			);
		}
		const room = MAX_PENDING_IMAGES - ctx.pendingImages.length;
		if (room < 2) {
			return toolResult(
				toolError(
					`Too many images pending (${ctx.pendingImages.length}). Answer about the images you already have before looking around.`
				)
			);
		}
		const access = cameraAccessRefusal(ctx);
		const named = access ? null : resolveCamera(args.camera);
		if (named && !canAim(named)) return toolResult(toolError(CANT_MOVE));
		const gate = await cameraGate(ctx, args.camera, 'move');
		if (!gate.camera) return refused(gate);
		const camera = gate.camera;
		let sweep: Sweep;
		try {
			sweep = await withCameraActivity(camera.id, 'move', () =>
				runSweep(
					(aim) => aimCamera(camera, aim),
					() => shoot(camera),
					room
				)
			);
		} catch (e) {
			return toolResult(toolError(`${camera.name}: ${errorText(e)}`));
		}
		const when = stamp();
		const n = sweep.shots.length;
		sweep.shots.forEach((dataUrl, i) =>
			ctx.pendingImages.push({
				path: `camera:${camera.name} sweep ${i + 1} of ${n} ${when}`,
				dataUrl
			})
		);
		return {
			result: describeSweep(camera.name, sweep, when),
			thumbDataUrl: sweep.shots[0]
		};
	}
});

/** What the model is told a sweep did. */
export function describeSweep(name: string, sweep: Sweep, when: string): string {
	const n = sweep.shots.length;
	const from = sweep.leftEnd ? 'its far left' : 'as far left as it went';
	const to = sweep.rightEnd ? 'its far right' : 'as far right as the pictures allowed';
	return `Swept ${name} from ${from} to ${to} and took ${n} picture${n === 1 ? '' : 's'} at ${when}, numbered 1 (leftmost) to ${n} (rightmost), each a large turn (about 60°) apart. It is back at its home position. You can now see them — describe the whole view in your next response.`;
}

/** A refusal from the gate: the user's no as a plain answer, everything else as an error. */
export function refused(gate: { refusal: string; declined?: boolean }) {
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
