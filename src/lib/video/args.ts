/**
 * The video tools' arguments, checked and shaped for the Rust commands.
 */
import { getSettings } from '#lib/stores/settings.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import { VIDEO_PRESETS } from '#lib/video/types.ts';
import type { CutSpec } from '#lib/ipc/gen/CutSpec.ts';
import type { Format } from '#lib/ipc/gen/Format.ts';
import type { CutItemSpec } from '#lib/ipc/gen/CutItemSpec.ts';
import type { CutAudioSpec } from '#lib/ipc/gen/CutAudioSpec.ts';
import type { EndClip } from '#lib/ipc/gen/EndClip.ts';
import type { ProjectOp } from '#lib/ipc/gen/ProjectOp.ts';
import type { VideoSettings } from '#lib/ipc/gen/VideoSettings.ts';
import type { Chapter } from '#lib/ipc/gen/Chapter.ts';
import type { Fit } from '#lib/ipc/gen/Fit.ts';
import type { RangeSpec } from '#lib/ipc/gen/RangeSpec.ts';
import { parsedFiniteOrNull, trimmedOrNull } from '#lib/utils/coerce.ts';

/** What the Rust side needs from Settings → Video editing. */
export function videoSettings(): VideoSettings {
	const s = getSettings();
	return {
		overrides: videoOverrides(),
		intro: s.videoIntroPath,
		outro: s.videoOutroPath,
		preset: s.videoPreset,
		editor: s.videoEditor
	};
}

/** The `episode` argument, or '' when there is none. */
export function episodeArg(args: Record<string, unknown>): string {
	return typeof args.episode === 'string' ? args.episode : '';
}

/** `intro` / `outro`: "settings" (or true) for the one in Settings → Video editing, else a path. */
export function endClip(v: unknown): EndClip | null {
	if (v === true) return true;
	if (v === false) return false;
	const s = trimmedOrNull(v);
	if (!s) return null;
	if (['settings', 'true', 'yes'].includes(s.toLowerCase())) return true;
	if (['none', 'false', 'no'].includes(s.toLowerCase())) return false;
	return s;
}

/** `audio`: the sounds under the picture, null when the call leaves them as they are. */
export function parseAudio(v: unknown): CutAudioSpec[] | null | string {
	if (v === undefined || v === null) return null;
	if (!Array.isArray(v)) return 'audio must be a list of sounds.';
	const out: CutAudioSpec[] = [];
	for (const [n, it] of v.entries()) {
		if (!it || typeof it !== 'object') return `audio[${n}] must be an object.`;
		const o = it as Record<string, unknown>;
		const index = parsedFiniteOrNull(o.index);
		const path = trimmedOrNull(o.path);
		if ((index === null) === (path === null)) {
			return `audio[${n}] needs exactly one of index (a sound already on the audio tracks, from 1) or path (a new one).`;
		}
		const at = o.at ?? o.at_secs;
		const atSecs = at === undefined || at === null ? null : parseTime(at);
		if (at !== undefined && at !== null && atSecs === null) {
			return `audio[${n}].at must be a time in the video, like 12.5 or "1:02.5".`;
		}
		out.push({
			index: index === null ? null : Math.round(index),
			path,
			atSecs,
			inSecs: parsedFiniteOrNull(o.in_secs),
			outSecs: parsedFiniteOrNull(o.out_secs),
			lufs: parsedFiniteOrNull(o.lufs)
		});
	}
	return out;
}

/** Exact trims, as `video_cut` items and `video_edit`'s trim take them. */
export const FRAME_PARAMS = {
	in_frame: {
		type: 'integer',
		description: "Instead of in_secs: the first frame shown, from 0, at the project's frame rate."
	},
	out_frame: { type: 'integer', description: 'Instead of out_secs: the last frame shown.' }
};

/** A clip's fit, as `video_cut` items and `video_edit` take it. */
export const FIT_PARAMS = {
	fit: {
		type: 'string',
		enum: ['letterbox', 'fill', 'crop'],
		description:
			'How the picture fills a frame of another shape: letterbox (the whole picture, with bars; the default), fill (edge to edge, the spare cut off around the centre), or crop (the region in crop).'
	},
	crop: {
		type: 'object',
		description: 'With fit crop: the region kept, as fractions 0–1 of the source picture.',
		properties: {
			x: { type: 'number' },
			y: { type: 'number' },
			w: { type: 'number' },
			h: { type: 'number' }
		}
	}
};

const FIT_WRONG = 'fit must be letterbox, fill or crop (with crop: {x, y, w, h}).';

/** A crop region {x, y, w, h} inside the picture, or what is wrong with it. */
function cropRegion(region: unknown): Fit | string {
	const o = region as Record<string, unknown>;
	const [x, y, w, h] = [o.x, o.y, o.w, o.h].map(parsedFiniteOrNull);
	if (x === null || y === null || w === null || h === null) {
		return 'A crop region needs x, y, w and h, as fractions 0–1 of the picture.';
	}
	const inside = [x, y, w, h].every((n) => n >= 0 && n <= 1) && w > 0 && h > 0;
	if (!inside || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) {
		return 'A crop region must stay inside the picture: fractions 0–1, x + w and y + h at most 1.';
	}
	return { mode: 'crop', x, y, w, h };
}

/**
 * `fit`: "letterbox", "fill", or "crop" with `crop` {x, y, w, h} as fractions
 * of the source frame (a crop region given as `fit` itself works too). Null
 * when none was given; a string says what is wrong.
 */
export function parseFit(fit: unknown, crop?: unknown): Fit | null | string {
	if (fit === undefined || fit === null) return null;
	if (typeof fit !== 'string') return fit && typeof fit === 'object' ? cropRegion(fit) : FIT_WRONG;
	const s = fit.trim().toLowerCase();
	if (s === 'letterbox' || s === 'fill') return { mode: s };
	if (s !== 'crop') return FIT_WRONG;
	return crop && typeof crop === 'object' ? cropRegion(crop) : 'fit crop needs crop: {x, y, w, h}.';
}

/** A gain range, as `video_cut` items and `video_edit` take one. */
export const GAIN_RANGE_PARAMS = {
	range_from: {
		type: 'string',
		description: 'gain_range: where it starts in the clip\'s own time, e.g. "0:12.4".'
	},
	range_to: { type: 'string', description: 'gain_range: where it ends.' },
	gain_db: {
		type: 'number',
		description: 'gain_range: the gain over it, -70 (mute) to +20 dB. Default -70.'
	}
};

/** `video_cut` items' `gain_ranges` and `hold_after_secs`. */
export const ITEM_RANGES_PARAM = {
	hold_after_secs: {
		type: 'number',
		description: 'Hold its last frame this long after it, up to 60 s.'
	},
	gain_ranges: {
		type: 'array',
		description:
			'Gains over stretches of its sound, in its own time, replacing those set before: [{from, to, gain_db}]; gain_db -70 mutes.',
		items: {
			type: 'object',
			properties: {
				from: { type: 'string' },
				to: { type: 'string' },
				gain_db: { type: 'number' }
			}
		}
	}
};

/** One range `{from, to, gain_db}`, or what is wrong with it. */
export function parseRange(o: Record<string, unknown>, where: string): RangeSpec | string {
	const fromSecs = parseTime(o.from ?? o.range_from ?? o.from_secs);
	const toSecs = parseTime(o.to ?? o.range_to ?? o.to_secs);
	if (fromSecs === null || toSecs === null || toSecs <= fromSecs) {
		return `${where}needs from and to, times in the clip with to after from.`;
	}
	const gainDb = parsedFiniteOrNull(o.gain_db) ?? -70;
	if (gainDb > 20 || gainDb < -70) return `${where}gain_db is -70 (mute) to +20.`;
	return { fromSecs, toSecs, gainDb };
}

/** `gain_ranges`: a list of ranges, null when none was given. */
function parseRanges(v: unknown, where: string): RangeSpec[] | null | string {
	if (v === undefined || v === null) return null;
	if (!Array.isArray(v)) return `${where}gain_ranges must be a list.`;
	const out: RangeSpec[] = [];
	for (const [n, r] of v.entries()) {
		const one = parseRange((r ?? {}) as Record<string, unknown>, `${where}gain_ranges[${n}] `);
		if (typeof one === 'string') return one;
		out.push(one);
	}
	return out;
}

/** A whole frame number from 0, null for none, or what is wrong. */
function frameArg(v: unknown, name: string): number | null | string {
	if (v === undefined || v === null) return null;
	const n = parsedFiniteOrNull(v);
	if (n === null || n < 0 || !Number.isInteger(n)) return `${name} is a whole frame number from 0.`;
	return n;
}

/** `in_frame` / `out_frame`, or what is wrong with them. */
function framesOf(
	o: Record<string, unknown>,
	where: string
): { inFrame: number | null; outFrame: number | null } | string {
	const inFrame = frameArg(o.in_frame, `${where}in_frame`);
	if (typeof inFrame === 'string') return inFrame;
	const outFrame = frameArg(o.out_frame, `${where}out_frame`);
	if (typeof outFrame === 'string') return outFrame;
	if (inFrame !== null && outFrame !== null && outFrame < inFrame) {
		return `${where}out_frame comes before in_frame.`;
	}
	return { inFrame, outFrame };
}

/** `items`: the main track's clips, or what is wrong with them. */
function parseItems(v: unknown): CutItemSpec[] | string {
	const raw = Array.isArray(v) ? v : [];
	const items: CutItemSpec[] = [];
	for (const [n, it] of raw.entries()) {
		if (!it || typeof it !== 'object') return `items[${n}] must be an object.`;
		const o = it as Record<string, unknown>;
		const index = parsedFiniteOrNull(o.index);
		const path = trimmedOrNull(o.path);
		if ((index === null) === (path === null)) {
			return `items[${n}] needs exactly one of index (a clip already in the cut, from 1) or path (a new clip).`;
		}
		const frames = framesOf(o, `items[${n}].`);
		if (typeof frames === 'string') return frames;
		const fit = parseFit(o.fit, o.crop);
		if (typeof fit === 'string') return `items[${n}]: ${fit}`;
		const gainRanges = parseRanges(o.gain_ranges, `items[${n}].`);
		if (typeof gainRanges === 'string') return gainRanges;
		const holdAfterSecs = parsedFiniteOrNull(o.hold_after_secs);
		if (holdAfterSecs !== null && (holdAfterSecs <= 0 || holdAfterSecs > 60)) {
			return `items[${n}].hold_after_secs is more than 0 and at most 60.`;
		}
		items.push({
			index: index === null ? null : Math.round(index),
			path,
			inSecs: parsedFiniteOrNull(o.in_secs),
			outSecs: parsedFiniteOrNull(o.out_secs),
			...frames,
			crossfadeSecs: parsedFiniteOrNull(o.crossfade_secs),
			fit,
			gainRanges,
			holdAfterSecs
		});
	}
	return items;
}

/** The tool's arguments as the Rust side's cut, or what is wrong with them. */
export function parseCut(args: Record<string, unknown>): CutSpec | string {
	const items = parseItems(args.items);
	if (typeof items === 'string') return items;
	const preset = trimmedOrNull(args.preset);
	if (preset && !VIDEO_PRESETS.some((p) => p.id === preset)) {
		return `preset must be one of ${VIDEO_PRESETS.map((p) => p.id).join(', ')}.`;
	}
	const editor = trimmedOrNull(args.editor)?.toLowerCase() ?? null;
	if (editor && editor !== 'shotcut' && editor !== 'kdenlive') {
		return 'editor must be shotcut or kdenlive.';
	}
	const audio = parseAudio(args.audio);
	if (typeof audio === 'string') return audio;
	return {
		project: trimmedOrNull(args.project),
		editor: editor as Format | null,
		preset,
		intro: endClip(args.intro),
		outro: endClip(args.outro),
		items,
		audio,
		crossfadeSecs: parsedFiniteOrNull(args.crossfade_secs),
		normalize: typeof args.normalize === 'boolean' ? args.normalize : null
	};
}

/** `75`, `"1:15"`, `"1:15.5"` or `"0:01:15"` as seconds; null when it is none of those. */
export function parseTime(v: unknown): number | null {
	const n = parsedFiniteOrNull(v);
	if (n !== null) return n;
	const s = trimmedOrNull(v);
	if (!s || !/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(s)) return null;
	return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

function trimOp(args: Record<string, unknown>, index: number): ProjectOp | string {
	const inSecs = parsedFiniteOrNull(args.in_secs);
	const outSecs = parsedFiniteOrNull(args.out_secs);
	const frames = framesOf(args, '');
	if (typeof frames === 'string') return frames;
	const none = [inSecs, outSecs, frames.inFrame, frames.outFrame].every((v) => v === null);
	if (none) return 'A trim needs in_secs, out_secs, in_frame or out_frame.';
	return { op: 'trim', index, inSecs, outSecs, ...frames };
}

function fitOp(args: Record<string, unknown>, index: number): ProjectOp | string {
	const fit = parseFit(args.fit, args.crop);
	if (fit === null) return 'A fit needs "fit": letterbox, fill or crop (with crop: {x, y, w, h}).';
	if (typeof fit === 'string') return fit;
	return { op: 'fit', index, fit };
}

function rangeOp(op: string, args: Record<string, unknown>, index: number): ProjectOp | string {
	if (op === 'clear_gain_ranges') return { op: 'clearGainRanges', index };
	const r = parseRange(args, 'gain_range ');
	return typeof r === 'string' ? r : { op: 'gainRange', index, ...r };
}

function removeRangesOp(args: Record<string, unknown>, index: number): ProjectOp | string {
	const raw = Array.isArray(args.ranges) ? args.ranges : [];
	const ranges = raw.flatMap((r) => {
		const o = (r ?? {}) as Record<string, unknown>;
		const start = parseTime(o.from);
		const end = parseTime(o.to);
		return start !== null && end !== null && end > start ? [{ start, end }] : [];
	});
	if (ranges.length === 0)
		return 'remove_ranges needs "ranges": [{from, to}] in the clip\'s own time.';
	return { op: 'removeRanges', index, ranges };
}

function moveOp(args: Record<string, unknown>, index: number): ProjectOp | string {
	const to = parsedFiniteOrNull(args.to);
	if (to === null) return 'A move needs "to", the position from 1.';
	return { op: 'move', from: index, to };
}

function holdOp(args: Record<string, unknown>, index: number): ProjectOp | string {
	const secs = parseTime(args.secs);
	if (secs === null || secs <= 0 || secs > 60)
		return 'A hold needs "secs", more than 0 and at most 60.';
	const end = trimmedOrNull(args.end)?.toLowerCase() ?? 'last';
	if (end !== 'first' && end !== 'last') return 'end is first or last.';
	const at = args.at === undefined || args.at === null ? null : parseTime(args.at);
	if (args.at !== undefined && args.at !== null && at === null) {
		return 'at is a time in the clip\'s own time, like 2.5 or "0:02.5".';
	}
	return { op: 'hold', index, end, atSecs: at, secs };
}

/** `video_edit`'s ops on one clip, by name. */
const CLIP_OPS: Record<
	string,
	(args: Record<string, unknown>, index: number) => ProjectOp | string
> = {
	trim: trimOp,
	fit: fitOp,
	gain_range: (args, index) => rangeOp('gain_range', args, index),
	clear_gain_ranges: (args, index) => rangeOp('clear_gain_ranges', args, index),
	hold: holdOp,
	remove: (_, index) => ({ op: 'remove', index }),
	move: moveOp,
	remove_ranges: removeRangesOp
};

/** Every `video_edit` op, as its schema lists them. */
export const EDIT_OPS = [...Object.keys(CLIP_OPS), 'remove_silences'];

export function parseOp(args: Record<string, unknown>): ProjectOp | string {
	const op = trimmedOrNull(args.op);
	if (op === 'remove_silences') {
		const index = parsedFiniteOrNull(args.index);
		return {
			op: 'removeSilences',
			index: index === null ? null : Math.round(index),
			minSecs: parsedFiniteOrNull(args.min_secs) ?? 1.5,
			padSecs: parsedFiniteOrNull(args.pad_secs) ?? 0.25
		};
	}
	const parse = op ? CLIP_OPS[op] : undefined;
	if (!parse) return `op must be ${EDIT_OPS.join(', ')}.`;
	const index = parsedFiniteOrNull(args.index);
	if (index === null) return 'video_edit needs "index", the clip number from 1.';
	return parse(args, index);
}

/** `chapters: [{title, at}]` as the Rust side takes them, or what is wrong. */
export function parseChapters(v: unknown): Chapter[] | string {
	const raw = Array.isArray(v) ? v : [];
	const out: Chapter[] = [];
	for (const [n, c] of raw.entries()) {
		const o = (c ?? {}) as Record<string, unknown>;
		const title = trimmedOrNull(o.title);
		const at = parseTime(o.at);
		if (!title || at === null) return `chapters[${n}] needs "title" and "at" (a time like 1:23).`;
		out.push({ title, atSecs: at });
	}
	if (out.length === 0) return 'video_chapters needs "chapters".';
	return out;
}
