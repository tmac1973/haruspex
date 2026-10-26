/**
 * The video tools' arguments, checked and shaped for the Rust commands.
 */
import { getSettings } from '#lib/stores/settings.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import { VIDEO_PRESETS } from '#lib/video/types.ts';
import type { CutSpec } from '#lib/ipc/gen/CutSpec.ts';
import type { CutItemSpec } from '#lib/ipc/gen/CutItemSpec.ts';
import type { EndClip } from '#lib/ipc/gen/EndClip.ts';
import type { ProjectOp } from '#lib/ipc/gen/ProjectOp.ts';
import type { VideoSettings } from '#lib/ipc/gen/VideoSettings.ts';
import type { Chapter } from '#lib/ipc/gen/Chapter.ts';

/** What the Rust side needs from Settings → Video editing. */
export function videoSettings(): VideoSettings {
	const s = getSettings();
	return {
		overrides: videoOverrides(),
		intro: s.videoIntroPath,
		outro: s.videoOutroPath,
		preset: s.videoPreset
	};
}

export function num(v: unknown): number | null {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
	return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | null {
	return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** `intro` / `outro`: "settings" (or true) for the one in Settings → Video editing, else a path. */
export function endClip(v: unknown): EndClip | null {
	if (v === true) return true;
	if (v === false) return false;
	const s = str(v);
	if (!s) return null;
	if (['settings', 'true', 'yes'].includes(s.toLowerCase())) return true;
	if (['none', 'false', 'no'].includes(s.toLowerCase())) return false;
	return s;
}

/** The tool's arguments as the Rust side's cut, or what is wrong with them. */
export function parseCut(args: Record<string, unknown>): CutSpec | string {
	const raw = Array.isArray(args.items) ? args.items : [];
	const items: CutItemSpec[] = [];
	for (const [n, it] of raw.entries()) {
		if (!it || typeof it !== 'object') return `items[${n}] must be an object.`;
		const o = it as Record<string, unknown>;
		const index = num(o.index);
		const path = str(o.path);
		if ((index === null) === (path === null)) {
			return `items[${n}] needs exactly one of index (a clip already in the cut, from 1) or path (a new clip).`;
		}
		items.push({
			index: index === null ? null : Math.round(index),
			path,
			inSecs: num(o.in_secs),
			outSecs: num(o.out_secs),
			crossfadeSecs: num(o.crossfade_secs)
		});
	}
	const preset = str(args.preset);
	if (preset && !VIDEO_PRESETS.some((p) => p.id === preset)) {
		return `preset must be one of ${VIDEO_PRESETS.map((p) => p.id).join(', ')}.`;
	}
	return {
		project: str(args.project),
		preset,
		intro: endClip(args.intro),
		outro: endClip(args.outro),
		items,
		crossfadeSecs: num(args.crossfade_secs),
		normalize: typeof args.normalize === 'boolean' ? args.normalize : null
	};
}

/** `75`, `"1:15"`, `"1:15.5"` or `"0:01:15"` as seconds; null when it is none of those. */
export function parseTime(v: unknown): number | null {
	const n = num(v);
	if (n !== null) return n;
	const s = str(v);
	if (!s || !/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(s)) return null;
	return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

export function parseOp(args: Record<string, unknown>): ProjectOp | string {
	const op = str(args.op);
	if (op === 'remove_silences') {
		const index = num(args.index);
		return {
			op: 'removeSilences',
			index: index === null ? null : Math.round(index),
			minSecs: num(args.min_secs) ?? 1.5,
			padSecs: num(args.pad_secs) ?? 0.25
		};
	}
	const index = num(args.index);
	if (index === null) return 'video_edit needs "index", the clip number from 1.';
	if (op === 'trim') {
		const inSecs = num(args.in_secs);
		const outSecs = num(args.out_secs);
		if (inSecs === null && outSecs === null) return 'A trim needs in_secs, out_secs or both.';
		return { op: 'trim', index, inSecs, outSecs };
	}
	if (op === 'remove') return { op: 'remove', index };
	if (op === 'remove_ranges') {
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
	if (op === 'move') {
		const to = num(args.to);
		if (to === null) return 'A move needs "to", the position from 1.';
		return { op: 'move', from: index, to };
	}
	return 'op must be trim, remove, move, remove_ranges or remove_silences.';
}

/** `chapters: [{title, at}]` as the Rust side takes them, or what is wrong. */
export function parseChapters(v: unknown): Chapter[] | string {
	const raw = Array.isArray(v) ? v : [];
	const out: Chapter[] = [];
	for (const [n, c] of raw.entries()) {
		const o = (c ?? {}) as Record<string, unknown>;
		const title = str(o.title);
		const at = parseTime(o.at);
		if (!title || at === null) return `chapters[${n}] needs "title" and "at" (a time like 1:23).`;
		out.push({ title, atSecs: at });
	}
	if (out.length === 0) return 'video_chapters needs "chapters".';
	return out;
}
