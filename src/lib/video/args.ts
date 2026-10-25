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

/** What the Rust side needs from Settings → Video. */
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

/** `intro` / `outro`: "settings" (or true) for the one in Settings → Video, else a path. */
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
			outSecs: num(o.out_secs)
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
		items
	};
}

export function parseOp(args: Record<string, unknown>): ProjectOp | string {
	const op = str(args.op);
	const index = num(args.index);
	if (index === null) return 'video_edit needs "index", the clip number from 1.';
	if (op === 'trim') {
		const inSecs = num(args.in_secs);
		const outSecs = num(args.out_secs);
		if (inSecs === null && outSecs === null) return 'A trim needs in_secs, out_secs or both.';
		return { op: 'trim', index, inSecs, outSecs };
	}
	if (op === 'remove') return { op: 'remove', index };
	if (op === 'move') {
		const to = num(args.to);
		if (to === null) return 'A move needs "to", the position from 1.';
		return { op: 'move', from: index, to };
	}
	return 'op must be trim, remove or move.';
}
