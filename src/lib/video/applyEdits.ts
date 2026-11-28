/**
 * The project changes one speech edit makes, worked out here so the model
 * never does the time arithmetic: a cut widened by 30 ms each side and
 * snapped to frames; a replacement muted under its take, with the take
 * fitted to the gap or the picture trimmed or held to the take's length
 * (`fitCut.ts`), then placed on an audio track at the gap's cut time.
 */
import type { ProjectOp } from '#lib/ipc/gen/ProjectOp.ts';
import { planReplacement, type ReplacementPlan } from '#lib/video/fitCut.ts';
import type { MappedEdit } from '#lib/video/edits.ts';

/** How far a cut reaches past its words, so no breath or click is left. */
export const CUT_PAD_SECS = 0.03;

type Placed = Extract<MappedEdit, { ok: true }>;

/** `t` on the frame grid of `fps`: down for a start, up for an end. */
function snap(t: number, fps: number, up: boolean): number {
	const f = t * fps;
	return Math.max(0, (up ? Math.ceil(f - 1e-6) : Math.floor(f + 1e-6)) / fps);
}

/** The op that cuts a struck stretch out, in its clip's own time. */
export function cutOp(m: Placed, fps: number): ProjectOp {
	return {
		op: 'removeRanges',
		index: m.index,
		ranges: [
			{
				start: snap(m.clipFrom - CUT_PAD_SECS, fps, false),
				end: snap(m.clipTo + CUT_PAD_SECS, fps, true)
			}
		]
	};
}

export interface ReplacementSteps {
	plan: ReplacementPlan;
	/** Stretch the take to this file first, at this pace. */
	stretch: { factor: number; to: string } | null;
	/** Then these, in order. */
	ops: ProjectOp[];
}

/**
 * What placing a take of `takeSecs` (at `take`, relative to the working
 * folder) over the gap `m` takes. `fitted` is where a stretched copy goes.
 */
export function replacementSteps(
	m: Placed,
	takeSecs: number,
	mode: 'auto' | 'fit' | 'cut',
	take: string,
	fitted: string,
	fps: number
): ReplacementSteps {
	const plan = planReplacement(m.secs, takeSecs, mode);
	const mute = (to: number): ProjectOp => ({
		op: 'gainRange',
		index: m.index,
		fromSecs: m.clipFrom,
		toSecs: to,
		gainDb: -70
	});
	const place = (path: string): ProjectOp => ({
		op: 'addAudio',
		path,
		atSecs: m.cutFrom,
		lufs: null
	});
	if (plan.mode === 'fit') {
		return {
			plan,
			stretch: { factor: plan.speed, to: fitted },
			ops: [mute(m.clipTo), place(fitted)]
		};
	}
	// The clip's own seconds per second of the cut.
	const pace = m.secs > 0 ? (m.clipTo - m.clipFrom) / m.secs : 1;
	if ('trimSecs' in plan) {
		const keepTo = snap(m.clipTo - plan.trimSecs * pace, fps, true);
		const tail: ProjectOp = {
			op: 'removeRanges',
			index: m.index,
			ranges: [{ start: keepTo, end: snap(m.clipTo, fps, true) }]
		};
		return { plan, stretch: null, ops: [tail, mute(keepTo), place(take)] };
	}
	const hold: ProjectOp = {
		op: 'hold',
		index: m.index,
		end: 'last',
		atSecs: snap(m.clipTo, fps, true),
		// Up to whole frames, with snap's slack: 1.1 − 1.0 is a hair over 0.1.
		secs: Math.ceil(plan.holdSecs * fps - 1e-6) / fps
	};
	return { plan, stretch: null, ops: [mute(m.clipTo), hold, place(take)] };
}
