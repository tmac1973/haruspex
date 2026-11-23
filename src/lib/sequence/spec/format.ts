/**
 * The format a sequence's project is made in, shared by the spec checks
 * (which note when a speaking instance's frame rate differs) and Assemble.
 */
import type { ClipPlan } from '#lib/sequence/spec/plan.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';

/** The formats a project is made in, as `mlt/profile.rs` has them. */
const PRESETS: { id: string; width: number; height: number; fps: number }[] = [
	{ id: '720p24', width: 1280, height: 720, fps: 24 },
	{ id: '1080p30', width: 1920, height: 1080, fps: 30 },
	{ id: '1080p60', width: 1920, height: 1080, fps: 60 },
	{ id: '1440p60', width: 2560, height: 1440, fps: 60 },
	{ id: '2160p30', width: 3840, height: 2160, fps: 30 }
];

/**
 * The project format: the preset nearest the video model's own size at its
 * frame rate (720p24 for LTX-2.3's 1280×704), else the spec's, else the one
 * in Settings → Video editing when it has the model's frame rate, else the
 * first that does (720p24 for Wan's 832×480 at 24 fps), else Settings'. A
 * 24 fps video in a 60 fps project only repeats frames.
 */
export function projectFormat(
	plan: Pick<ClipPlan, 'width' | 'height' | 'fps'>,
	spec: Pick<SequenceSpec, 'preset'>,
	settingsPreset: string
): { preset: string; width: number; height: number; fps: number } {
	const near = PRESETS.find(
		(p) =>
			p.fps === plan.fps &&
			Math.abs(p.width - plan.width) <= 64 &&
			Math.abs(p.height - plan.height) <= 32
	);
	const sameRate = (id: string) => PRESETS.find((p) => p.id === id)?.fps === plan.fps;
	const byRate = sameRate(settingsPreset)
		? settingsPreset
		: PRESETS.find((p) => p.fps === plan.fps)?.id;
	const id = near?.id ?? spec.preset ?? byRate ?? settingsPreset;
	const p = PRESETS.find((x) => x.id === id) ?? PRESETS[2];
	return { preset: p.id, width: p.width, height: p.height, fps: p.fps };
}
