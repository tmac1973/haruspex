/**
 * What a sequence run has done, kept in the episode folder
 * (`.haruspex/sequence-progress.json`) so a run that stopped carries on from
 * the next missing piece.
 *
 * Every entry keeps the key of what made it: a clip's key covers its plan
 * item and the key of what it starts from, so changing one clip's prompt
 * resets it and every clip chained after it, and nothing else. A keyframe's
 * key covers the style and its section's prompt.
 */
import type { VideoJobHandle } from '#lib/videogen/types.ts';
import type { ClipPlan, PlanItem, StartRef, EndRef } from '#lib/sequence/spec/plan.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ClipProgress {
	key: string;
	status: StepStatus;
	handle?: VideoJobHandle;
	/** The clip, relative to the episode folder. */
	file?: string;
	seed?: number;
	/** The clip has a sound track. */
	hasAudio?: boolean;
	/** How long it took to make, in seconds. */
	secs?: number;
	check?: { ok: boolean; problem?: string };
}

export interface FileProgress {
	key: string;
	status: StepStatus;
	file?: string;
}

export interface SequenceProgress {
	specHash: string;
	clips: Record<string, ClipProgress>;
	keyframes: Record<string, FileProgress>;
	music: Record<string, FileProgress>;
	narration: Record<string, FileProgress>;
	project?: string;
	render?: string;
}

/** JSON with every object's keys in order, so equal values give equal text. */
export function stableJson(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
	if (v && typeof v === 'object') {
		const o = v as Record<string, unknown>;
		const keys = Object.keys(o)
			.filter((k) => o[k] !== undefined)
			.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
	}
	return JSON.stringify(v);
}

/** A short hash of a value's stable JSON: two FNV-1a passes, 16 hex digits. */
export function hashOf(v: unknown): string {
	const text = stableJson(v);
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ 0x5bd1e995;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193);
		b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
	}
	const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
	return hex(a) + hex(b);
}

export function emptyProgress(specHash: string): SequenceProgress {
	return { specHash, clips: {}, keyframes: {}, music: {}, narration: {} };
}

/** Each section's keyframe key. */
function keyframeKeys(spec: SequenceSpec): Record<string, string> {
	const out: Record<string, string> = {};
	for (const s of spec.sections) {
		if (s.kind !== 'generated' || s.start_image) continue;
		out[s.id] = hashOf({ style: spec.style, prompt: s.keyframe_prompt ?? s.prompt });
	}
	return out;
}

/**
 * A music bed's key: the bed and how long the sections under it are, so a
 * section that gets longer or shorter makes its music again.
 */
function musicKey(spec: SequenceSpec, bed: SequenceSpec['sound']['music'][number]): string {
	// Only how long they are: a new prompt doesn't change the music.
	const lengths = bed.sections.map((id) => {
		const s = spec.sections.find((x) => x.id === id);
		if (!s) return null;
		return s.kind === 'generated' ? s.seconds : [s.path, s.in_secs, s.out_secs];
	});
	return hashOf({ bed, lengths });
}

/** A re-anchor still's id in the progress file. */
export const reanchorId = (section: string, n: number) => `${section}-r${n}`;

/** An existing clip's first-frame still's id in the progress file. */
export const firstFrameId = (section: string) => `${section}-first`;

/**
 * Every still's key: each section's keyframe, each re-anchor (which follows
 * its section's keyframe), and the first frame of each existing clip a
 * transition ends on.
 */
export function stillKeys(spec: SequenceSpec, plan: ClipPlan): Record<string, string> {
	const out = keyframeKeys(spec);
	for (const item of plan.items) {
		if (item.kind !== 'generate' || !item.end) continue;
		const end = item.end;
		if (end.kind === 'reanchor') {
			const base = out[end.section];
			if (base)
				out[reanchorId(end.section, end.n)] = hashOf({ base, n: end.n, prompt: item.prompt });
		} else if (end.kind === 'firstFrameOf') {
			const clip = plan.items.find((i) => i.id === end.id);
			if (clip?.kind === 'existing') {
				out[firstFrameId(clip.section)] = hashOf({ path: clip.path, in: clip.in_secs ?? 0 });
			}
		}
	}
	return out;
}

/** Each plan item's key, chained through what it starts and ends on. */
export function itemKeys(spec: SequenceSpec, plan: ClipPlan): Record<string, string> {
	const kf = keyframeKeys(spec);
	const keys: Record<string, string> = {};
	const refKey = (r: StartRef | EndRef | undefined): string | null => {
		if (!r) return null;
		switch (r.kind) {
			case 'keyframe':
				return kf[r.section] ?? null;
			case 'reanchor':
				return kf[r.section] ?? null;
			case 'lastFrameOf':
			case 'firstFrameOf':
				return keys[r.id] ?? null;
			case 'startOf':
				return refKey(r.start);
			default:
				return null;
		}
	};
	// Items come in order, except a transition, which ends on the clip after it.
	const later: PlanItem[] = [];
	for (const item of plan.items) {
		if (item.kind === 'generate' && item.end?.kind === 'firstFrameOf') {
			later.push(item);
			continue;
		}
		keys[item.id] = hashOf({ item, size: [plan.width, plan.height, plan.fps], ...deps(item) });
	}
	for (const item of later) {
		keys[item.id] = hashOf({ item, size: [plan.width, plan.height, plan.fps], ...deps(item) });
	}
	return keys;

	function deps(item: PlanItem) {
		return item.kind === 'generate'
			? { from: refKey(item.start), to: refKey(item.end) }
			: { from: null, to: null };
	}
}

function keep<T extends { key: string; status: StepStatus }>(
	old: Record<string, T>,
	keys: Record<string, string>
): Record<string, T> {
	const out: Record<string, T> = {};
	for (const [id, key] of Object.entries(keys)) {
		const was = old[id];
		if (was && was.key === key && was.status === 'done') out[id] = was;
	}
	return out;
}

/**
 * The progress for `spec`, from what an earlier run left: done work whose
 * key still matches is kept, everything else starts again. A spec that is
 * byte for byte the same keeps everything as it was.
 */
export function mergeProgress(
	old: SequenceProgress | null,
	spec: SequenceSpec,
	plan: ClipPlan
): SequenceProgress {
	const specHash = hashOf(spec);
	if (old && old.specHash === specHash) return old;
	const fresh = emptyProgress(specHash);
	if (!old) return fresh;
	fresh.clips = keep(old.clips, itemKeys(spec, plan));
	fresh.keyframes = keep(old.keyframes, stillKeys(spec, plan));
	const musicKeys = Object.fromEntries(spec.sound.music.map((m) => [m.id, musicKey(spec, m)]));
	fresh.music = keep(old.music, musicKeys);
	const lineKeys = Object.fromEntries(
		spec.sound.narration.map((n, i) => [`${n.section}-${i + 1}`, hashOf(n)])
	);
	fresh.narration = keep(old.narration, lineKeys);
	return fresh;
}

/** The key each piece of the run is made under, for a stage to record. */
export function progressKeys(spec: SequenceSpec, plan: ClipPlan) {
	return {
		clips: itemKeys(spec, plan),
		keyframes: stillKeys(spec, plan),
		music: Object.fromEntries(spec.sound.music.map((m) => [m.id, musicKey(spec, m)])),
		narration: Object.fromEntries(
			spec.sound.narration.map((n, i) => [`${n.section}-${i + 1}`, hashOf(n)])
		)
	};
}
