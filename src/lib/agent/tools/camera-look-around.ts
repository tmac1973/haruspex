/**
 * `camera_look_around`: sweep a pan/tilt camera from its far left to its far
 * right, a picture at each stop, then send it home. A calibrated camera
 * (Settings → Cameras → Calibrate) steps a little under a picture width so
 * the pictures overlap; an uncalibrated one steps its smallest turn and finds
 * each end by its picture no longer changing (`camera_aim`'s `unmoved`).
 */
import type { Aim } from '#lib/ipc/gen/Aim.ts';
import type { CameraAimResult } from '#lib/ipc/gen/CameraAimResult.ts';
import type { PtzCalibration } from '#lib/ipc/gen/PtzCalibration.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolResult, toolError } from '#lib/agent/tools/types.ts';
import { cameraAccessRefusal, cameraGate, resolveCamera } from '#lib/agent/tools/_cameraGate.ts';
import { stamp } from '#lib/camera/log.ts';
import { withCameraActivity } from '#lib/stores/cameraActivity.svelte.ts';
import {
	aimCamera,
	CAMERA_PARAM,
	canAim,
	CANT_MOVE,
	errorText,
	refused,
	shoot,
	widths
} from '#lib/agent/tools/camera.ts';

/** The most large turns a sweep makes looking for the left end. */
export const SWEEP_MAX_TURNS = 8;
/** The most steps a sweep makes looking for the right end. */
const SWEEP_MAX_STEPS = 20;
/** A sweep's pictures: more than a lone look allows, and smaller. */
export const SWEEP_MAX_PICTURES = 10;
const SWEEP_WIDTH = 640;
/** A step short of a picture width, so neighbouring pictures overlap. */
const SWEEP_OVERLAP = 0.85;

/** How a sweep gets to the left end and steps right. */
export interface SweepPlan {
	toLeft: Aim;
	/** Repeat `toLeft` until the picture stops changing; else once is enough. */
	repeatToLeft: boolean;
	step: Aim;
	/** Picture widths per step, when calibrated. */
	stepViews: number | null;
	/** Steps from the left end to the right, when calibrated. */
	steps: number | null;
}

/**
 * A calibrated camera steps a little under a picture width, widened when
 * that would take more than `room` pictures to cover; an uncalibrated one
 * steps its smallest turn and may not reach the far end.
 */
export function sweepPlan(cal: PtzCalibration | undefined, room: number): SweepPlan {
	if (!cal) {
		return {
			toLeft: { direction: 'left', amount: 'large' },
			repeatToLeft: true,
			step: { direction: 'right', amount: 'small' },
			stepViews: null,
			steps: null
		};
	}
	let pulses = Math.max(1, Math.floor(SWEEP_OVERLAP / cal.viewsPerPulse));
	if (Math.ceil(cal.rangePulses / pulses) + 1 > room) {
		pulses = Math.ceil(cal.rangePulses / Math.max(1, room - 1));
	}
	return {
		toLeft: { direction: 'left', pulses: Math.min(20, cal.rangePulses + 1) },
		repeatToLeft: false,
		step: { direction: 'right', pulses },
		stepViews: pulses * cal.viewsPerPulse,
		steps: Math.ceil(cal.rangePulses / pulses)
	};
}

export interface Sweep {
	/** Pictures, leftmost first. */
	shots: string[];
	/** Whether it found the end of the camera's travel on each side. */
	leftEnd: boolean;
	rightEnd: boolean;
}

/**
 * Turn the camera to its far left, then right a step at a time taking a
 * picture at each stop, until it goes no further or `room` pictures are taken;
 * then send it home. A turn that leaves the picture unchanged takes none.
 */
export async function runSweep(
	aim: (a: Aim) => Promise<CameraAimResult>,
	take: () => Promise<string>,
	room: number,
	plan: SweepPlan
): Promise<Sweep> {
	let leftEnd = false;
	if (plan.repeatToLeft) {
		for (let i = 0; i < SWEEP_MAX_TURNS && !leftEnd; i++) {
			leftEnd = (await aim(plan.toLeft)).atLimit;
		}
	} else {
		// A calibrated camera turned its whole range left is at the end.
		await aim(plan.toLeft);
		leftEnd = true;
	}
	const shots = [await take()];
	let rightEnd = false;
	const steps = plan.steps ?? SWEEP_MAX_STEPS;
	let taken = 0;
	for (; taken < steps && shots.length < room && !rightEnd; taken++) {
		const moved = await aim(plan.step);
		rightEnd = moved.atLimit;
		if (!moved.unmoved) shots.push(await take());
	}
	// A calibrated camera that took all its steps is at the right end.
	if (plan.steps != null && taken === plan.steps) rightEnd = true;
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
				"Sweep one of the user's pan/tilt cameras across its whole range, left to right, taking a picture at each stop, then point it back home. Use it when the user asks to look around, scan or survey the room. It keeps the camera's tilt: turn it up or down with camera_look first if needed. Takes a minute or two.",
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
		const room = SWEEP_MAX_PICTURES - ctx.pendingImages.length;
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
		const plan = sweepPlan(camera.calibration, room);
		let sweep: Sweep;
		try {
			sweep = await withCameraActivity(camera.id, 'move', () =>
				runSweep(
					(aim) => aimCamera(camera, aim),
					() => shoot(camera, SWEEP_WIDTH),
					room,
					plan
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
			result: describeSweep(camera.name, sweep, when, plan.stepViews),
			thumbDataUrl: sweep.shots[0]
		};
	}
});

/** What the model is told a sweep did. */
export function describeSweep(
	name: string,
	sweep: Sweep,
	when: string,
	stepViews: number | null
): string {
	const n = sweep.shots.length;
	const from = sweep.leftEnd ? 'its far left' : 'as far left as it went';
	const to = sweep.rightEnd ? 'its far right' : 'as far right as the pictures allowed';
	const spacing =
		stepViews == null
			? "Neighbouring pictures may overlap, so don't count the same thing twice."
			: stepViews < 1
				? `Each is about ${widths(stepViews)} right of the one before, so neighbours overlap; don't count the same thing twice.`
				: `Each is about ${widths(stepViews)} right of the one before, so there may be narrow gaps between them.`;
	const calibrate =
		stepViews == null && !sweep.rightEnd
			? ' The camera is not calibrated (Settings → Cameras → Calibrate), so the sweep may not cover its whole range.'
			: '';
	return `Swept ${name} from ${from} to ${to} and took ${n} picture${n === 1 ? '' : 's'} at ${when}, numbered 1 (leftmost) to ${n} (rightmost). ${spacing}${calibrate} It is back at its home position. You can now see them — describe the whole view in your next response.`;
}
