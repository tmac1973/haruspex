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
import type { ClipPlan, GenerateItem, PlanItem } from '#lib/sequence/spec/plan.ts';
import type { SoundMade } from '#lib/agent/jobs/types/video-sequence/sound.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';

export { projectFormat } from '#lib/sequence/spec/format.ts';

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
/** A speaking window's speech, in seconds: its clip is cut to it. */
export function speechSecs(item: GenerateItem): number {
	return (item.audio?.parts ?? []).reduce((n, p) => n + p.to_secs - p.from_secs, 0);
}

/** Between a speaking section's windows, when it asks for a crossfade. */
export const WINDOW_CROSSFADE = 0.3;

function lengthOf(item: PlanItem, fps: number, existing: Record<string, ExistingClip>): number {
	if (item.kind === 'generate' && item.audio) return speechSecs(item);
	if (item.kind === 'generate') return (item.frames - (item.trimFirstFrame ? 1 : 0)) / fps;
	const end = item.out_secs ?? existing[item.path]?.secs ?? 0;
	return Math.max(0, end - (item.in_secs ?? 0));
}

/**
 * How long `item` crossfades from what comes before it: a crossfade join
 * into a new section, or a speaking section's windows asking for one.
 */
function crossfadeInto(
	item: PlanItem,
	spec: SequenceSpec,
	lastSection: string | null,
	secs: number
): number {
	if (lastSection === null) return 0;
	if (item.section !== lastSection) {
		const k = spec.sections.findIndex((s) => s.id === item.section);
		const join = spec.joins[k - 1];
		return join?.kind === 'crossfade' ? Math.min(join.secs ?? 1, secs / 2) : 0;
	}
	if (item.kind !== 'generate' || !item.audio) return 0;
	const own = spec.sections.find((s) => s.id === item.section);
	return own?.kind === 'speaking' && own.window_join === 'crossfade'
		? Math.min(WINDOW_CROSSFADE, secs / 2)
		: 0;
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
		const isJoin = item.kind === 'generate' && item.join !== undefined;
		const crossfade = isJoin ? 0 : crossfadeInto(item, spec, lastSection, secs);
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

/**
 * A speaking window on the main track: cut to its speech, with its own
 * sound muted, since its speech goes on an audio track (`speechPlaced`).
 */
function windowItem(
	item: GenerateItem,
	file: string,
	crossfade: number,
	plan: ClipPlan,
	format: { width: number; height: number }
): CutItemSpec {
	const fps = item.fps ?? plan.fps;
	const size = plan.speakingSize ?? plan;
	return {
		...blankItem(),
		path: file,
		outFrame: Math.max(0, Math.round(speechSecs(item) * fps) - 1),
		crossfadeSecs: crossfade || null,
		fit: fitFor(size.width, size.height, format),
		gainRanges: [{ fromSecs: 0, toSecs: item.frames / fps, gainDb: -70 }]
	};
}

/** A generated clip on the main track, its own sound muted unless the spec keeps it. */
function generatedItem(
	item: GenerateItem,
	clip: ClipOnDisk,
	crossfade: number,
	input: CutInput
): CutItemSpec {
	const mute = !input.spec.sound.clip_sound && clip.hasAudio;
	const secs = item.frames / input.plan.fps;
	return {
		...blankItem(),
		path: clip.file,
		inFrame: item.trimFirstFrame ? 1 : null,
		crossfadeSecs: crossfade || null,
		fit: fitFor(input.plan.width, input.plan.height, input.format),
		gainRanges: mute ? [{ fromSecs: 0, toSecs: secs, gainDb: -70 }] : null
	};
}

/**
 * Where each sound goes, and how loud: music under speech (narration, or a
 * speaking section) or under clip sound sits at -30 LUFS.
 */
export function placeSound(spec: SequenceSpec, sound: SoundMade): SoundPlaced[] {
	const speaks = spec.sections.some((s) => s.kind === 'speaking');
	const under = spec.sound.narration.length > 0 || spec.sound.clip_sound || speaks;
	return [
		...sound.beds.map((b) => ({
			file: b.file,
			atSecs: b.start,
			lufs: spec.sound.music.find((m) => m.id === b.id)?.lufs ?? (under ? -30 : -14)
		})),
		...sound.lines.map((l) => ({ file: l.file, atSecs: l.at, lufs: -14 }))
	];
}

/** Each speaking window's speech, at the window's time in the cut, at -14 LUFS as speech. */
export function speechPlaced(
	spec: SequenceSpec,
	plan: ClipPlan,
	existing: Record<string, ExistingClip>
): SoundPlaced[] {
	const placed = timeline(spec, plan, existing).items;
	return plan.items.flatMap((item, k) =>
		item.kind === 'generate' && item.audio
			? [{ file: item.audio.out, atSecs: placed[k].start, lufs: -14 }]
			: []
	);
}

/** The cut for `video_project_cut`, and notes for the report. */
export function buildCut(input: CutInput): { cut: CutSpec; notes: string[] } {
	const { spec, plan, clips, existing, path, format } = input;
	const placed = timeline(spec, plan, existing).items;
	const notes: string[] = [];
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
		if (item.audio) return windowItem(item, path(clip.file), crossfade, plan, format);
		return generatedItem(item, { ...clip, file: path(clip.file) }, crossfade, input);
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
