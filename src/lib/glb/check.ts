/**
 * Everything a tool does with GLB bytes before it reports: load, inspect,
 * normalise when asked, check the clips, draw the sheet (or one clip's
 * motion sheet) and write the report's text. The GLB specialist's check and
 * `check_3d` both come through here.
 */
import { formatReport } from '#lib/glb/format.ts';
import { disposeTree, loadGlb, type LoadedGlb, type Three } from '#lib/glb/load.ts';
import { normaliseGlb, type NormaliseOptions } from '#lib/glb/normalise.ts';
import { inspectGlb, type Bounds, type GlbReport } from '#lib/glb/report.ts';
import { inspectMotion } from '#lib/glb/motion.ts';
import { formatClip, formatClipLines } from '#lib/glb/motionFormat.ts';
import { renderMotionSheet } from '#lib/glb/motionSheet.ts';
import { renderSheet } from '#lib/glb/sheet.ts';
import { validateGlb } from '#lib/glb/validate.ts';

export interface CheckOptions extends NormaliseOptions {
	maxTriangles?: number;
	/** A clip to show moving: its motion sheet replaces the still sheet. */
	clip?: string;
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
	const inspect = { maxTriangles: opts.maxTriangles };
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
	const shown = describe(loaded, report, opts.clip, normalisedFrom);
	if ('problems' in shown) return shown;
	const invalid = opts.clip ? [] : (await validateGlb(bytes)).lines;
	const text = invalid.length
		? `${shown.text}\nglTF validation (other engines reject or mis-draw these):\n${invalid.join('\n')}`
		: shown.text;
	return { bytes, report, normalisedFrom, ...shown, text, invalid };
}

/**
 * The sheet and the text: the still sheet with a line per clip, or `clip`'s
 * motion sheet and detail. Disposes of the scene either way.
 */
function describe(
	{ THREE, gltf }: { THREE: Three; gltf: LoadedGlb },
	report: GlbReport,
	clip: string | undefined,
	normalisedFrom: Bounds | undefined
): Pick<GlbCheck, 'text' | 'png' | 'clip'> | { problems: string[] } {
	const anim = clip ? gltf.animations.find((a) => a.name === clip) : undefined;
	if (clip && !anim) {
		disposeTree(gltf.scene);
		const names = gltf.animations.map((a) => a.name);
		const has = names.length ? `Clips: ${names.join(', ')}.` : 'The GLB has no clips.';
		return { problems: [`No clip named ${clip}. ${has}`] };
	}
	// After normalising, so the floor is where the written GLB has it.
	const clips = inspectMotion(THREE, gltf);
	const motion = anim && clips.find((c) => c.name === anim.name);
	const png =
		anim && motion
			? renderMotionSheet(THREE, gltf.scene, anim, motion.fastest)
			: renderSheet(THREE, gltf.scene, report.bounds);
	disposeTree(gltf.scene);
	const text = formatReport(report, {
		normalisedFrom,
		clipLines: formatClipLines(clips),
		clipDetail: motion ? formatClip(motion, png !== null) : undefined,
		clip: anim?.name
	});
	return { text, png, clip: anim?.name };
}
