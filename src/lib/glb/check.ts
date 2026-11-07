/**
 * Everything a tool does with GLB bytes before it reports: load, inspect,
 * normalise when asked, check the clips, draw the sheet (or one clip's
 * motion sheet) and write the report's text. The GLB specialist's check and
 * `check_3d` both come through here.
 */
import type { AnimationClip } from 'three';
import { formatReport } from '#lib/glb/format.ts';
import { disposeTree, loadGlb, type LoadedGlb, type Three } from '#lib/glb/load.ts';
import { normaliseGlb, type NormaliseOptions } from '#lib/glb/normalise.ts';
import { inspectGlb, type Bounds, type GlbReport } from '#lib/glb/report.ts';
import { inspectMotion, type MotionOptions } from '#lib/glb/motion.ts';
import { formatClip, formatClipLines } from '#lib/glb/motionFormat.ts';
import { renderMotionSheet } from '#lib/glb/motionSheet.ts';
import { closeUpBounds, renderSheet } from '#lib/glb/sheet.ts';
import { validateGlb } from '#lib/glb/validate.ts';

export interface CheckOptions extends NormaliseOptions, MotionOptions {
	maxTriangles?: number;
	/** A clip to show moving: its motion sheet replaces the still sheet. */
	clip?: string;
	/** A part (a node's name, or "head") to show close up in place of the whole. */
	view?: string;
	/** The height it should be (m): the report warns when it is off by over 10%. */
	specHeight?: number;
}

export interface GlbCheck {
	/** The GLB to write: the input, or its normalised copy. */
	bytes: Uint8Array;
	report: GlbReport;
	text: string;
	/** The render sheet, or null when WebGL couldn't draw it. */
	png: string | null;
	/** The bounds before normalisation, when it was asked for. */
	normalisedFrom?: Bounds;
	/** The clip the sheet shows moving, when one was asked for. */
	clip?: string;
	/** What the sheet shows close up, when a view was asked for. */
	closeUp?: string;
	/**
	 * The glTF validator's issues, one line per kind; empty when it found none.
	 * Not run for a clip's motion sheet: the file is the one the still check saw.
	 */
	invalid: string[];
}

/** Check GLB bytes; `problems` when they fail (no GLB to write). */
export async function checkGlb(
	bytes: Uint8Array,
	opts: CheckOptions = {}
): Promise<GlbCheck | { problems: string[] }> {
	let loaded = await loadGlb(bytes);
	if ('error' in loaded) return { problems: [loaded.error] };
	const inspect = { maxTriangles: opts.maxTriangles, specHeight: opts.specHeight };
	let report = inspectGlb(loaded.THREE, loaded.gltf, inspect);
	if (report.problems.length) {
		disposeTree(loaded.gltf.scene);
		return { problems: report.problems };
	}
	let normalisedFrom: Bounds | undefined;
	if (opts.height !== undefined || opts.ground) {
		const n = await normaliseGlb(loaded.THREE, loaded.gltf, opts);
		disposeTree(loaded.gltf.scene);
		if ('error' in n) return { problems: [n.error] };
		bytes = n.bytes;
		normalisedFrom = n.before;
		loaded = await loadGlb(bytes);
		if ('error' in loaded) return { problems: [loaded.error] };
		report = inspectGlb(loaded.THREE, loaded.gltf, inspect);
	}
	const shown = describe(loaded, report, opts, normalisedFrom);
	if ('problems' in shown) return shown;
	const invalid = opts.clip ? [] : (await validateGlb(bytes)).lines;
	const text = invalid.length
		? `${shown.text}\nglTF validation (other engines reject or mis-draw these):\n${invalid.join('\n')}`
		: shown.text;
	return { bytes, report, normalisedFrom, ...shown, text, invalid };
}

/** The clip to show moving, or the part to show close up; or why there is no such thing. */
function whatToShow(
	THREE: Three,
	gltf: LoadedGlb,
	report: GlbReport,
	clip: string | undefined,
	view: string | undefined
):
	| {
			anim: AnimationClip | undefined;
			close: { bounds: Bounds; label: string; note?: string } | null;
	  }
	| { problems: string[] } {
	const anim = clip ? gltf.animations.find((a) => a.name === clip) : undefined;
	if (clip && !anim) {
		const names = gltf.animations.map((a) => a.name);
		const has = names.length ? `Clips: ${names.join(', ')}.` : 'The GLB has no clips.';
		return { problems: [`No clip named ${clip}. ${has}`] };
	}
	const close = view && !anim ? closeUpBounds(THREE, gltf.scene, view, report.bounds) : null;
	if (close && 'error' in close) return { problems: [close.error] };
	return { anim, close };
}

/**
 * The sheet and the text: the still sheet (or a close-up) with a line per
 * clip, or `clip`'s motion sheet and detail. Disposes of the scene either way.
 */
function describe(
	{ THREE, gltf }: { THREE: Three; gltf: LoadedGlb },
	report: GlbReport,
	{ clip, loops, view }: CheckOptions,
	normalisedFrom: Bounds | undefined
): Pick<GlbCheck, 'text' | 'png' | 'clip' | 'closeUp'> | { problems: string[] } {
	const asked = whatToShow(THREE, gltf, report, clip, view);
	if ('problems' in asked) {
		disposeTree(gltf.scene);
		return asked;
	}
	const { anim, close } = asked;
	// After normalising, so the floor is where the written GLB has it.
	const clips = inspectMotion(THREE, gltf, { loops });
	const motion = anim && clips.find((c) => c.name === anim.name);
	const png =
		anim && motion
			? renderMotionSheet(THREE, gltf.scene, anim, motion.fastest)
			: renderSheet(THREE, gltf.scene, close?.bounds ?? report.bounds, !!close);
	disposeTree(gltf.scene);
	const formatted = formatReport(report, {
		normalisedFrom,
		clipLines: formatClipLines(clips),
		clipDetail: motion ? formatClip(motion, png !== null) : undefined,
		clip: anim?.name
	});
	const text = close?.note ? `${formatted}\n${close.note}` : formatted;
	return { text, png, clip: anim?.name, closeUp: close?.label };
}
