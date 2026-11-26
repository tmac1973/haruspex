/**
 * Checking a parsed spec against what the run will use: the video instance
 * (its limits and capabilities), whether an image and a music backend are
 * set up, and the files in the episode folder.
 *
 * What can't work is an error, naming the section. What can work another
 * way is changed and said in a note: a transition the instance can't end on
 * becomes a 1 s crossfade, re-anchoring it can't do is turned off, and clip
 * sound an instance doesn't make is dropped. There is no length cap.
 */
import type { VideoLimits } from '#lib/toolchest/models.ts';
import { VIDEO_PRESETS } from '#lib/video/types.ts';
import type {
	ExistingSection,
	Section,
	SequenceSpec,
	SpeakingSection
} from '#lib/sequence/spec/types.ts';

export interface ValidateContext {
	/** The video instance's id, for messages. */
	instance: string;
	limits: VideoLimits;
	/** Its capabilities: `text`, `start_image`, `end_image`, … */
	capabilities: string[];
	/**
	 * What the other video models can do that this one can't, when the job
	 * leaves the model to Automatic: a clip that needs one of them goes to
	 * another model rather than being refused.
	 */
	othersCan?: string[];
	/** An image backend is set up, so sections can open on a keyframe. */
	imageBackend: boolean;
	musicBackend: boolean;
	/** Files in the episode folder, relative to it with forward slashes. */
	files: Set<string>;
	/** Whether the instance's clips have sound; null until a clip says. */
	clipSound?: boolean | null;
	/** The instance speaking sections use (Wan2.2 S2V), when the job names one. */
	speaking?: { instance: string; limits: VideoLimits; capabilities: string[] };
	/** The project's frame rate, for the note when the speaking instance's differs. */
	projectFps?: number;
}

export interface Validated {
	/** The spec with the notes' changes made. */
	spec: SequenceSpec;
	errors: string[];
	notes: string[];
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Said once when Automatic sends some clips to another video model. */
export const OTHER_MODEL = 'No one video model can do every clip, so some clips use another.';

const clean = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** A section's length in seconds, when the spec says it. */
function sectionSecs(s: Section): number | null {
	if (s.kind === 'generated') return s.seconds;
	if (s.kind === 'speaking') return null;
	if (s.out_secs !== undefined) return s.out_secs - (s.in_secs ?? 0);
	return null;
}

function checkSpeaking(
	s: SpeakingSection,
	ctx: ValidateContext,
	errors: string[],
	notes: string[]
) {
	const name = `Section ${s.id}`;
	const sp = ctx.speaking;
	if (!sp || !sp.capabilities.includes('audio')) {
		errors.push(
			`${name}: a speaking section needs a speaking video instance (Wan2.2 S2V); choose one as the job's speaking model.`
		);
	}
	if (s.portrait && !ctx.files.has(clean(s.portrait))) {
		errors.push(`${name}: ${s.portrait} is not in the episode folder.`);
	} else if (!s.portrait && !ctx.imageBackend) {
		errors.push(
			`${name}: give a portrait of the person, or set up an image backend in Settings → Image generation to draw one.`
		);
	}
	for (const l of s.lines) {
		if (!SLUG.test(l.id)) errors.push(`${name}: line id ${l.id} must be a short lowercase slug.`);
	}
	const fixed = sp?.limits.fixedFps;
	if (fixed && ctx.projectFps && fixed !== ctx.projectFps) {
		notes.push(`${name}: ${sp.instance} makes ${fixed} fps; the project is ${ctx.projectFps} fps.`);
	}
}

function checkExisting(s: ExistingSection, ctx: ValidateContext, errors: string[]): void {
	const name = `Section ${s.id}`;
	if (!ctx.files.has(clean(s.path))) {
		errors.push(`${name}: ${s.path} is not in the episode folder.`);
	}
	if ((s.in_secs ?? 0) < 0) errors.push(`${name}: in_secs can't be before 0.`);
	if (s.out_secs !== undefined && s.out_secs <= (s.in_secs ?? 0)) {
		errors.push(`${name}: out_secs must come after in_secs.`);
	}
}

function checkSection(s: Section, ctx: ValidateContext, errors: string[], notes: string[]): void {
	if (s.kind === 'existing') return checkExisting(s, ctx, errors);
	if (s.kind === 'speaking') return checkSpeaking(s, ctx, errors, notes);
	const name = `Section ${s.id}`;
	if (!(s.seconds > 0)) errors.push(`${name}: seconds must be more than 0.`);
	const can = (c: string) => {
		if (ctx.capabilities.includes(c)) return true;
		if (!ctx.othersCan?.includes(c)) return false;
		if (!notes.includes(OTHER_MODEL)) notes.push(OTHER_MODEL);
		return true;
	};
	if (s.start_image) {
		if (!ctx.files.has(clean(s.start_image))) {
			errors.push(`${name}: ${s.start_image} is not in the episode folder.`);
		}
		if (!can('start_image')) {
			errors.push(`${name}: ${ctx.instance} can't start from a picture; remove start_image.`);
		}
		return;
	}
	const keyframe = ctx.imageBackend && can('start_image');
	if (!keyframe && !can('text')) {
		errors.push(
			`${name}: ${ctx.instance} needs a picture to start from. Give a start_image, or set up an image backend in Settings → Image generation for a keyframe.`
		);
	} else if (!keyframe) {
		notes.push(`${name} opens from its prompt alone, with no keyframe.`);
	}
}

function checkJoins(spec: SequenceSpec, ctx: ValidateContext, errors: string[], notes: string[]) {
	const endImage = ctx.capabilities.includes('end_image');
	spec.joins = spec.joins.map((j, k) => {
		const name = `The join after section ${spec.sections[k]?.id ?? k + 1}`;
		if (j.kind === 'transition' && !(endImage && ctx.capabilities.includes('start_image'))) {
			notes.push(
				`${name} is a 1 s crossfade: ${ctx.instance} can't make a clip that ends on a picture.`
			);
			return { kind: 'crossfade', secs: 1 };
		}
		if (j.kind === 'crossfade' && j.secs !== undefined && (j.secs <= 0 || j.secs > 3)) {
			errors.push(`${name}: a crossfade is more than 0 and at most 3 s.`);
		}
		return j;
	});
	if (spec.reanchor_every < 0 || !Number.isInteger(spec.reanchor_every)) {
		errors.push('reanchor_every is a whole number from 0 (off).');
	} else if (spec.reanchor_every > 0 && !endImage) {
		notes.push(`Re-anchoring is off: ${ctx.instance} can't end a clip on a picture.`);
		spec.reanchor_every = 0;
	}
}

function checkMusic(spec: SequenceSpec, ctx: ValidateContext, errors: string[]): void {
	const ids = new Set(spec.sections.map((s) => s.id));
	const beds = new Set<string>();
	for (const bed of spec.sound.music) {
		const name = `Music ${bed.id}`;
		if (!SLUG.test(bed.id)) errors.push(`${name}: its id must be a short lowercase slug.`);
		if (beds.has(bed.id)) errors.push(`${name}: two beds have this id.`);
		beds.add(bed.id);
		const missing = bed.sections.filter((s) => !ids.has(s));
		errors.push(...missing.map((s) => `${name}: there is no section ${s}.`));
		const lufs = bed.lufs ?? -30;
		if (lufs < -40 || lufs > -10) errors.push(`${name}: lufs is -40 to -10.`);
	}
	if (spec.sound.music.length > 0 && !ctx.musicBackend) {
		errors.push(
			'The spec asks for music; set up music generation in Settings → Music generation first.'
		);
	}
}

function checkNarration(spec: SequenceSpec, errors: string[]): void {
	for (const n of spec.sound.narration) {
		const s = spec.sections.find((x) => x.id === n.section);
		if (!s) {
			errors.push(`Narration "${n.text.slice(0, 30)}": there is no section ${n.section}.`);
			continue;
		}
		const secs = sectionSecs(s);
		if (n.at_secs < 0 || (secs !== null && n.at_secs >= secs)) {
			errors.push(`Narration in section ${n.section}: at_secs must be inside the section.`);
		}
	}
}

function checkSound(spec: SequenceSpec, ctx: ValidateContext, errors: string[], notes: string[]) {
	checkMusic(spec, ctx, errors);
	checkNarration(spec, errors);
	if (spec.sound.clip_sound && ctx.clipSound === false) {
		notes.push(`Clip sound is off: ${ctx.instance} makes silent clips.`);
		spec.sound.clip_sound = false;
	}
}

/** Check `spec` for this run; the returned spec has the notes' changes made. */
export function validateSequenceSpec(spec: SequenceSpec, ctx: ValidateContext): Validated {
	const out: SequenceSpec = structuredClone(spec);
	const errors: string[] = [];
	const notes: string[] = [];
	const seen = new Set<string>();
	for (const s of out.sections) {
		if (!SLUG.test(s.id)) {
			errors.push(`Section ${s.id}: its id must be a short lowercase slug, like "snow".`);
		}
		if (seen.has(s.id)) errors.push(`Section ${s.id}: two sections have this id.`);
		seen.add(s.id);
		checkSection(s, ctx, errors, notes);
	}
	const lineIds = out.sections.flatMap((s) =>
		s.kind === 'speaking' ? s.lines.map((l) => l.id) : []
	);
	for (const id of new Set(lineIds.filter((id, i) => lineIds.indexOf(id) !== i))) {
		errors.push(`Line ${id}: two lines have this id.`);
	}
	checkJoins(out, ctx, errors, notes);
	checkSound(out, ctx, errors, notes);
	if (out.preset && !VIDEO_PRESETS.some((p) => p.id === out.preset)) {
		errors.push(`preset must be one of ${VIDEO_PRESETS.map((p) => p.id).join(', ')}.`);
	}
	return { spec: out, errors, notes };
}
