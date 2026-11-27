/**
 * A validated spec as the ordered list of what the run makes and places:
 * each generated section cut into clips of the instance's longest, chained
 * last frame to first, with re-anchors and transition clips between, and
 * existing clips as they are. Pure, so every stage plans the same way.
 */
import type { Fit } from '#lib/ipc/gen/Fit.ts';
import { longestClip } from '#lib/videogen/fit.ts';
import type { VideoCaps } from '#lib/videogen/types.ts';
import type { GeneratedSection, SequenceSpec, SpeakingSection } from '#lib/sequence/spec/types.ts';
import {
	speakingFormat,
	windowFile,
	windowsOf,
	type Speaking,
	type WindowAudio
} from '#lib/sequence/spec/speaking.ts';

/** Where a generated clip starts. */
export type StartRef =
	/** The section's keyframe still, made by the image backend. */
	| { kind: 'keyframe'; section: string }
	/** A picture the user gave, in the episode folder. */
	| { kind: 'userImage'; path: string }
	/** The true last frame of an earlier clip. */
	| { kind: 'lastFrameOf'; id: string }
	/** Nothing: the prompt alone. */
	| { kind: 'text' }
	/** A speaking section's portrait: its own, or the keyframe drawn of it. */
	| { kind: 'portrait'; section: string };

/** What a generated clip ends on. */
export type EndRef =
	/** A fresh still of the section, so a long run doesn't drift. */
	| { kind: 'reanchor'; section: string; n: number }
	/** The picture a section's first clip starts from. */
	| { kind: 'startOf'; start: StartRef }
	/** The first frame of a clip, generated or existing. */
	| { kind: 'firstFrameOf'; id: string };

export interface GenerateItem {
	kind: 'generate';
	/** `<section>-NN`, or `join-K` for a transition. */
	id: string;
	section: string;
	/** For a transition: the join it fills, from 1. */
	join?: number;
	prompt: string;
	negative_prompt?: string;
	frames: number;
	seed?: number;
	start: StartRef;
	end?: EndRef;
	/** It repeats the frame it starts from, so the cut drops its first. */
	trimFirstFrame: boolean;
	/** A speaking window's own frame rate, when it isn't the plan's. */
	fps?: number;
	/** A speaking window's sound: its slices of the spoken lines. */
	audio?: WindowAudio;
	/** A speaking window planned from estimated line lengths, before the lines are spoken. */
	estimated?: boolean;
}

export interface ExistingItem {
	kind: 'existing';
	/** The section's id. */
	id: string;
	section: string;
	path: string;
	in_secs?: number;
	out_secs?: number;
	fit?: Fit;
}

export type PlanItem = GenerateItem | ExistingItem;

export interface ClipPlan {
	items: PlanItem[];
	width: number;
	height: number;
	fps: number;
	/** The longest clip the instance makes, in frames. */
	clipFrames: number;
	/** The speaking instance's clip size, when the plan has speaking windows. */
	speakingSize?: { width: number; height: number };
}

/** The smallest frame count the model takes (`step × n + 1`) of at least `n`. */
function atLeast(n: number, step = 4): number {
	return Math.max(1, Math.ceil((n - 1) / step) * step + 1);
}

/** `style. prompt`, or the prompt alone. */
function withStyle(style: string, prompt: string): string {
	return style ? `${style}. ${prompt}` : prompt;
}

/**
 * The frame counts of one section's clips, each new frame counted once, in
 * the model's frame steps (`step`: 4 for Wan, 8 for LTX) and none over `cap`.
 */
export function splitFrames(totalFrames: number, cap: number, step = 4): number[] {
	const out: number[] = [];
	let left = Math.max(1, totalFrames);
	while (left > 0) {
		// A continuation's first frame is its predecessor's last, so it adds one fewer.
		const extra = out.length === 0 ? 0 : 1;
		const f = Math.min(cap, atLeast(left + extra, step));
		out.push(f);
		left -= f - extra;
	}
	return out;
}

function sectionStart(s: GeneratedSection, keyframes: boolean): StartRef {
	if (s.start_image) return { kind: 'userImage', path: s.start_image };
	return keyframes ? { kind: 'keyframe', section: s.id } : { kind: 'text' };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A speaking section's windows, each one S2V clip from its portrait. Its own
 * prompt alone: the spec's style names the main subject, who isn't the speaker.
 */
function windowItems(spec: SequenceSpec, s: SpeakingSection, speaking: Speaking): GenerateItem[] {
	const f = speakingFormat(speaking.limits);
	return windowsOf(s, speaking, f.secs).map((w, i) => {
		const item: GenerateItem = {
			kind: 'generate',
			id: `${s.id}-${pad(i + 1)}`,
			section: s.id,
			prompt: s.prompt,
			frames: Math.min(f.frames, atLeast(Math.ceil(w.secs * f.fps))),
			fps: f.fps,
			start: { kind: 'portrait', section: s.id },
			trimFirstFrame: false,
			audio: { parts: w.parts, out: windowFile(s.id, i + 1) }
		};
		if (!speaking.speech) item.estimated = true;
		return item;
	});
}

/**
 * The plan for `spec` on `video`: its limits, and the frame counts it takes
 * (`frameStep`, 4 for Wan and 8 for LTX). `keyframes` says the run
 * makes a keyframe for each section without a start picture (an image
 * backend is set up and the instance starts from pictures). `speaking` is
 * the speaking instance and the lines spoken so far, for speaking sections.
 */
export function planClips(
	spec: SequenceSpec,
	video: Pick<VideoCaps, 'limits' | 'frameStep'>,
	keyframes: boolean,
	speaking?: Speaking
): ClipPlan {
	const frameStep = video.frameStep;
	const longest = longestClip(video);
	const { width, height, fps } = longest;
	const cap = longest.frames;
	const items: PlanItem[] = [];
	// Each section's first item, for transitions that end on it.
	const firsts = new Map<string, PlanItem>();
	const lastIds = new Map<string, string>();
	const pending: { k: number; join: SequenceSpec['joins'][number] }[] = [];
	spec.sections.forEach((s, k) => {
		if (s.kind === 'existing') {
			const item: ExistingItem = { kind: 'existing', id: s.id, section: s.id, path: s.path };
			if (s.in_secs !== undefined) item.in_secs = s.in_secs;
			if (s.out_secs !== undefined) item.out_secs = s.out_secs;
			if (s.fit) item.fit = s.fit;
			items.push(item);
			firsts.set(s.id, item);
			lastIds.set(s.id, item.id);
		} else if (s.kind === 'speaking') {
			const windows = speaking ? windowItems(spec, s, speaking) : [];
			items.push(...windows);
			if (windows.length) {
				firsts.set(s.id, windows[0]);
				lastIds.set(s.id, windows[windows.length - 1].id);
			}
		} else {
			const frames = splitFrames(Math.round(s.seconds * fps), cap, frameStep);
			let prev: string | null = null;
			frames.forEach((f, i) => {
				const n = i + 1;
				const item: GenerateItem = {
					kind: 'generate',
					id: `${s.id}-${pad(n)}`,
					section: s.id,
					prompt: withStyle(spec.style, s.prompt),
					frames: f,
					start: prev ? { kind: 'lastFrameOf', id: prev } : sectionStart(s, keyframes),
					trimFirstFrame: prev !== null
				};
				if (s.negative_prompt) item.negative_prompt = s.negative_prompt;
				if (s.seed !== undefined) item.seed = s.seed + i;
				if (spec.reanchor_every > 0 && n % spec.reanchor_every === 0) {
					item.end = { kind: 'reanchor', section: s.id, n };
				}
				items.push(item);
				if (!prev) firsts.set(s.id, item);
				prev = item.id;
			});
			lastIds.set(s.id, prev ?? s.id);
		}
		// A transition into this section goes before it once both ends are known.
		const before = pending.find((p) => p.k === k);
		// A speaking section with no speaking instance plans nothing; validation says why.
		if (before && firsts.has(s.id) && lastIds.has(spec.sections[k - 1].id)) {
			const at = items.indexOf(firsts.get(s.id)!);
			items.splice(
				at,
				0,
				transition(spec, before.k, before.join, firsts, lastIds, { cap, fps, step: frameStep })
			);
		}
		const join = spec.joins[k];
		if (join?.kind === 'transition') pending.push({ k: k + 1, join });
	});
	const plan: ClipPlan = { items, width, height, fps, clipFrames: cap };
	if (speaking && items.some((i) => i.kind === 'generate' && i.audio)) {
		const f = speakingFormat(speaking.limits);
		plan.speakingSize = { width: f.width, height: f.height };
	}
	return plan;
}

function transition(
	spec: SequenceSpec,
	k: number,
	join: SequenceSpec['joins'][number],
	firsts: Map<string, PlanItem>,
	lastIds: Map<string, string>,
	{ cap, fps, step }: { cap: number; fps: number; step: number }
): GenerateItem {
	const a = spec.sections[k - 1];
	const b = spec.sections[k];
	const first = firsts.get(b.id)!;
	const end: EndRef =
		first.kind === 'generate' && first.start.kind !== 'text'
			? { kind: 'startOf', start: first.start }
			: { kind: 'firstFrameOf', id: first.id };
	const what = (s: typeof a) => (s.kind === 'existing' ? 'the next clip' : s.prompt);
	const frames = join.secs ? Math.min(cap, atLeast(Math.round(join.secs * fps), step)) : cap;
	return {
		kind: 'generate',
		id: `join-${k}`,
		section: a.id,
		join: k,
		prompt: withStyle(spec.style, join.prompt ?? `${what(a)}, turning into ${what(b)}`),
		frames,
		start: { kind: 'lastFrameOf', id: lastIds.get(a.id)! },
		end,
		trimFirstFrame: true
	};
}
