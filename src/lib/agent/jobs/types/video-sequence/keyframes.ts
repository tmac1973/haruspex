/**
 * The Keyframes stage: the still each generated section opens on, the
 * re-anchor stills its clips end on, and the first frame of each existing
 * clip a transition ends on.
 *
 * One subject across sections: the first section's keyframe is drawn, and
 * each later one is an edit of it ("the same subject, in this place") when
 * the image backend can edit, so the summer fox is the snow fox. A backend
 * that can't edit draws each from the style and its prompt. A section with
 * the user's own start picture uses it as it is, and with no image backend a
 * section opens from its prompt alone.
 *
 * Every still is cut and scaled to the video's size, since a video model's
 * start picture has to be. One already done, whose key still matches, is
 * kept: a rerun makes only what is missing or changed.
 */
import type { ImageInput, ImageRequest, ImageResult } from '#lib/image/types.ts';
import type { ClipPlan } from '#lib/sequence/spec/plan.ts';
import type { GeneratedSection, SequenceSpec } from '#lib/sequence/spec/types.ts';
import type { FileProgress } from '#lib/sequence/spec/progress.ts';
import { firstFrameId, reanchorId } from '#lib/sequence/spec/progress.ts';
import { KEYFRAMES_DIR } from '#lib/sequence/spec/paths.ts';

/** What the stage reaches outside itself for. */
export interface KeyframeDeps {
	/** An image backend is set up and keyframes are on. */
	draws: boolean;
	/** It can edit a picture with a prompt. */
	canEdit: boolean;
	generate(req: ImageRequest): Promise<ImageResult>;
	/** The picture cut and scaled to exactly this size, as PNG. */
	fit(bytes: Uint8Array, width: number, height: number): Promise<Uint8Array>;
	/** Paths are relative to the episode folder. */
	write(rel: string, bytes: Uint8Array): Promise<void>;
	read(rel: string): Promise<Uint8Array | null>;
	exists(rel: string): Promise<boolean>;
	/** The first frame of a clip at `atSecs`, written to `out`. */
	firstFrame(clip: string, atSecs: number, out: string): Promise<void>;
	signal?: AbortSignal;
}

/** How one still came to be. */
export type StillHow = 'drawn' | 'edited' | 'kept' | 'user' | 'first-frame' | 'reused';

export interface Still {
	/** The progress id: the section, `<section>-r<n>`, or `<section>-first`. */
	id: string;
	section: string;
	/** Relative to the episode folder. */
	file: string;
	how: StillHow;
	/** For a re-anchor, the clip number it ends. */
	n?: number;
}

export interface KeyframeRun {
	spec: SequenceSpec;
	plan: ClipPlan;
	/** Each still's key, from `stillKeys`. */
	keys: Record<string, string>;
	/** What an earlier run left; updated as stills are made. */
	done: Record<string, FileProgress>;
	/** A section to make again whatever is on disk, with a note for its prompt. */
	redo?: { section: string; note: string };
}

/** Where a still goes in the episode folder. */
export function stillPath(id: string): string {
	return `${KEYFRAMES_DIR}/${id}.png`;
}

const IMAGE_STEP = 16;

/** The video's size, rounded to what image models take. */
export function drawSize(plan: ClipPlan): { width: number; height: number } {
	const r = (n: number) => Math.max(IMAGE_STEP, Math.round(n / IMAGE_STEP) * IMAGE_STEP);
	return { width: r(plan.width), height: r(plan.height) };
}

/** The subject first, so it stays in the image model's first 77 tokens; the style after. */
function withStyle(text: string, style: string): string {
	return style ? `${text}. ${style}` : text;
}

function subjectOf(s: GeneratedSection, note?: string): string {
	const what = s.keyframe_prompt ?? s.prompt;
	return note ? `${what}. ${note}` : what;
}

/** Make the stills the plan needs; what each is, in plan order. */
export async function makeKeyframes(run: KeyframeRun, deps: KeyframeDeps): Promise<Still[]> {
	const { spec, plan } = run;
	const stills: Still[] = [];
	const isDone = async (id: string) => {
		const was = run.done[id];
		if (!was || was.status !== 'done' || was.key !== run.keys[id]) return false;
		if (run.redo && (id === run.redo.section || id.startsWith(`${run.redo.section}-r`))) {
			return false;
		}
		return deps.exists(stillPath(id));
	};
	const record = (id: string) => {
		run.done[id] = { key: run.keys[id], status: 'done', file: stillPath(id) };
	};
	const save = async (id: string, result: ImageResult) => {
		const img = result.images[0];
		if (!img) throw new Error(`The image backend gave no picture for ${id}.`);
		await deps.write(stillPath(id), await deps.fit(img.bytes, plan.width, plan.height));
		record(id);
	};
	const size = drawSize(plan);
	let first: ImageInput | null = null;

	for (const s of spec.sections) {
		if (deps.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		if (s.kind !== 'generated') continue;
		if (s.start_image) {
			stills.push({ id: s.id, section: s.id, file: s.start_image, how: 'user' });
			continue;
		}
		if (!deps.draws) continue;
		const note = run.redo?.section === s.id ? run.redo.note : undefined;
		const id = s.id;
		if (await isDone(id)) {
			stills.push({ id, section: id, file: stillPath(id), how: 'kept' });
		} else if (first && deps.canEdit) {
			const prompt = withStyle(
				`The same subject as in the picture, now: ${subjectOf(s, note)}`,
				spec.style
			);
			await save(
				id,
				await deps.generate({ prompt, ...size, seed: null, edit: { images: [first] } })
			);
			stills.push({ id, section: id, file: stillPath(id), how: 'edited' });
		} else {
			const prompt = withStyle(subjectOf(s, note), spec.style);
			await save(id, await deps.generate({ prompt, ...size, seed: null }));
			stills.push({ id, section: id, file: stillPath(id), how: 'drawn' });
		}
		if (!first) {
			const bytes = await deps.read(stillPath(id));
			if (bytes) first = { name: `${id}.png`, bytes: Array.from(bytes) };
		}
	}
	stills.push(...(await reanchors(run, deps, stills, size, isDone, save)));
	stills.push(...(await firstFrames(run, deps, isDone, record)));
	return stills;
}

/** Re-anchor stills: an edit of the section's keyframe, or the keyframe itself. */
async function reanchors(
	run: KeyframeRun,
	deps: KeyframeDeps,
	keyframes: Still[],
	size: { width: number; height: number },
	isDone: (id: string) => Promise<boolean>,
	save: (id: string, r: ImageResult) => Promise<void>
): Promise<Still[]> {
	const out: Still[] = [];
	for (const item of run.plan.items) {
		if (item.kind !== 'generate' || item.end?.kind !== 'reanchor') continue;
		const { section, n } = item.end;
		const base = keyframes.find((k) => k.section === section);
		if (!base) continue;
		const id = reanchorId(section, n);
		if (!deps.canEdit || base.how === 'user') {
			// Nothing to vary it with: the clip ends where its section began.
			out.push({ id, section, n, file: base.file, how: 'reused' });
			continue;
		}
		if (await isDone(id)) {
			out.push({ id, section, n, file: stillPath(id), how: 'kept' });
			continue;
		}
		const bytes = await deps.read(base.file);
		if (!bytes) throw new Error(`The keyframe ${base.file} is missing.`);
		const prompt = withStyle(
			`The same subject and place as in the picture, a moment later: ${item.prompt}`,
			''
		);
		const edit = { images: [{ name: `${section}.png`, bytes: Array.from(bytes) }] };
		await save(id, await deps.generate({ prompt, ...size, seed: null, edit }));
		out.push({ id, section, n, file: stillPath(id), how: 'edited' });
	}
	return out;
}

/** The first frames of existing clips that a transition ends on. */
async function firstFrames(
	run: KeyframeRun,
	deps: KeyframeDeps,
	isDone: (id: string) => Promise<boolean>,
	record: (id: string) => void
): Promise<Still[]> {
	const out: Still[] = [];
	for (const item of run.plan.items) {
		if (item.kind !== 'generate' || item.end?.kind !== 'firstFrameOf') continue;
		const target = item.end.id;
		const clip = run.plan.items.find((i) => i.id === target);
		if (clip?.kind !== 'existing') continue;
		const id = firstFrameId(clip.section);
		if (!(await isDone(id))) {
			await deps.firstFrame(clip.path, clip.in_secs ?? 0, stillPath(id));
			record(id);
		}
		out.push({ id, section: clip.section, file: stillPath(id), how: 'first-frame' });
	}
	return out;
}

const HOW: Record<StillHow, string> = {
	drawn: 'drawn',
	edited: 'an edit of the first keyframe',
	kept: 'kept from the last run',
	user: 'your picture',
	'first-frame': "the clip's first frame",
	reused: 'the section keyframe again'
};

/** One line per still, for the step output. */
export function stillsSummary(stills: Still[]): string {
	if (stills.length === 0) {
		return 'No keyframes: each generated section opens from its prompt alone.';
	}
	return stills
		.map((s) => {
			const what = s.n ? `${s.section}, re-anchor at clip ${s.n}` : s.section;
			const how = s.how === 'edited' && s.n ? 'an edit of its keyframe' : HOW[s.how];
			return `- ${what}: ${s.file} (${how})`;
		})
		.join('\n');
}
