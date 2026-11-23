/**
 * The Assemble stage's arithmetic, pure: where every clip and section sits
 * in the cut, which format the project is made in, and the `CutSpec` that
 * `video_project_cut` turns into a normal Shotcut or Kdenlive project.
 *
 * Generated clips that continue from the one before drop their first frame
 * (the one they share with it). A crossfade join overlaps the two sections;
 * a transition clip sits between them with hard cuts on both sides. A
 * clip's own sound is kept when the spec asks; otherwise a gain range mutes
 * it, so the editor still has it to bring back.
 */
import type { CutAudioSpec } from '#lib/ipc/gen/CutAudioSpec.ts';
import type { CutItemSpec } from '#lib/ipc/gen/CutItemSpec.ts';
import type { CutSpec } from '#lib/ipc/gen/CutSpec.ts';
import type { Fit } from '#lib/ipc/gen/Fit.ts';
import type { Format } from '#lib/ipc/gen/Format.ts';
import type { ClipPlan, PlanItem } from '#lib/sequence/spec/plan.ts';
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
 * in Settings → Video editing.
 */
export function projectFormat(
	plan: Pick<ClipPlan, 'width' | 'height' | 'fps'>,
	spec: Pick<SequenceSpec, 'preset'>,
	settingsPreset: string
): { preset: string; width: number; height: number } {
	const near = PRESETS.find(
		(p) =>
			p.fps === plan.fps &&
			Math.abs(p.width - plan.width) <= 64 &&
			Math.abs(p.height - plan.height) <= 32
	);
	const id = near?.id ?? spec.preset ?? settingsPreset;
	const p = PRESETS.find((x) => x.id === id) ?? PRESETS[2];
	return { preset: p.id, width: p.width, height: p.height };
}

/** What Assemble knows of a clip on disk. */
export interface ClipOnDisk {
	/** Relative to the episode folder. */
	file: string;
	hasAudio?: boolean;
}

/** An existing clip, as the episode probe saw it. */
export interface ExistingClip {
	secs: number;
	width: number | null;
	height: number | null;
}

/** Where one plan item sits in the cut, in seconds. */
export interface Placed {
	id: string;
	section: string;
	start: number;
	secs: number;
	/** A crossfade into it. */
	crossfade: number;
}

/** One plan item's length in the cut. */
function lengthOf(item: PlanItem, fps: number, existing: Record<string, ExistingClip>): number {
	if (item.kind === 'generate') return (item.frames - (item.trimFirstFrame ? 1 : 0)) / fps;
	const end = item.out_secs ?? existing[item.path]?.secs ?? 0;
	return Math.max(0, end - (item.in_secs ?? 0));
}

/** Every item's place in the cut, and each section's start and end. */
export function timeline(
	spec: SequenceSpec,
	plan: ClipPlan,
	existing: Record<string, ExistingClip>
): { items: Placed[]; sections: Record<string, { start: number; end: number }>; total: number } {
	const items: Placed[] = [];
	const sections: Record<string, { start: number; end: number }> = {};
	let at = 0;
	let lastSection: string | null = null;
	for (const item of plan.items) {
		const secs = lengthOf(item, plan.fps, existing);
		// A crossfade join: the first item of the section after it overlaps.
		let crossfade = 0;
		const isJoin = item.kind === 'generate' && item.join !== undefined;
		if (!isJoin && lastSection !== null && item.section !== lastSection) {
			const k = spec.sections.findIndex((s) => s.id === item.section);
			const join = spec.joins[k - 1];
			if (join?.kind === 'crossfade') crossfade = Math.min(join.secs ?? 1, secs / 2);
		}
		const start = Math.max(0, at - crossfade);
		items.push({ id: item.id, section: item.section, start, secs, crossfade });
		at = start + secs;
		if (!isJoin) {
			const s = (sections[item.section] ??= { start, end: at });
			s.end = at;
			lastSection = item.section;
		}
	}
	return { items, sections, total: at };
}

const aspect = (w: number, h: number) => w / h;

/** Fill when the picture's shape differs from the project's by more than 1%. */
function fitFor(
	width: number | null,
	height: number | null,
	project: { width: number; height: number }
): Fit | null {
	if (!width || !height) return null;
	const off = Math.abs(aspect(width, height) / aspect(project.width, project.height) - 1);
	return off > 0.01 ? { mode: 'fill' } : null;
}

const blankItem = (): CutItemSpec => ({
	index: null,
	path: null,
	inSecs: null,
	outSecs: null,
	inFrame: null,
	outFrame: null,
	crossfadeSecs: null,
	fit: null,
	gainRanges: null,
	holdAfterSecs: null,
	speed: null
});

export interface SoundPlaced {
	/** Relative to the episode folder. */
	file: string;
	atSecs: number;
	lufs: number;
}

export interface CutInput {
	spec: SequenceSpec;
	plan: ClipPlan;
	clips: Record<string, ClipOnDisk>;
	existing: Record<string, ExistingClip>;
	/** Relative to the working folder: the path a file in the episode folder has. */
	path: (rel: string) => string;
	format: { preset: string; width: number; height: number };
	editor: Format | null;
	sound: SoundPlaced[];
}

/** The cut for `video_project_cut`, and notes for the report. */
export function buildCut(input: CutInput): { cut: CutSpec; notes: string[] } {
	const { spec, plan, clips, existing, path, format } = input;
	const placed = timeline(spec, plan, existing).items;
	const notes: string[] = [];
	const generatedFit = fitFor(plan.width, plan.height, format);
	const items = plan.items.map((item, k): CutItemSpec => {
		const crossfade = placed[k].crossfade;
		if (item.kind === 'existing') {
			const probe = existing[item.path];
			return {
				...blankItem(),
				path: path(item.path),
				inSecs: item.in_secs ?? null,
				outSecs: item.out_secs ?? null,
				crossfadeSecs: crossfade || null,
				fit: item.fit ?? fitFor(probe?.width ?? null, probe?.height ?? null, format)
			};
		}
		const clip = clips[item.id];
		if (!clip) throw new Error(`Clip ${item.id} was not made; run the job again to make it.`);
		const mute = !spec.sound.clip_sound && clip.hasAudio;
		const secs = item.frames / plan.fps;
		return {
			...blankItem(),
			path: path(clip.file),
			inFrame: item.trimFirstFrame ? 1 : null,
			crossfadeSecs: crossfade || null,
			fit: generatedFit,
			gainRanges: mute ? [{ fromSecs: 0, toSecs: secs, gainDb: -70 }] : null
		};
	});
	const generated = plan.items.filter((i) => i.kind === 'generate');
	if (spec.sound.clip_sound && !generated.some((i) => clips[i.id]?.hasAudio)) {
		notes.push('The clips have no sound of their own: the video model made them silent.');
	}
	const audio: CutAudioSpec[] = input.sound.map((s) => ({
		index: null,
		path: path(s.file),
		atSecs: s.atSecs,
		inSecs: null,
		outSecs: null,
		lufs: s.lufs
	}));
	return {
		cut: {
			project: null,
			editor: input.editor,
			preset: format.preset,
			intro: null,
			outro: null,
			items,
			audio: audio.length ? audio : null,
			crossfadeSecs: null,
			normalize: true
		},
		notes
	};
}
