/**
 * Everything a tool does with GLB bytes before it reports: load, inspect,
 * normalise when asked, draw the sheet and write the report's text. The GLB
 * specialist's check and `check_3d` both come through here.
 */
import { formatReport } from '#lib/glb/format.ts';
import { disposeTree, loadGlb } from '#lib/glb/load.ts';
import { normaliseGlb, type NormaliseOptions } from '#lib/glb/normalise.ts';
import { inspectGlb, type Bounds, type GlbReport } from '#lib/glb/report.ts';
import { renderSheet } from '#lib/glb/sheet.ts';

export interface CheckOptions extends NormaliseOptions {
	maxTriangles?: number;
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
	const png = renderSheet(loaded.THREE, loaded.gltf.scene, report.bounds);
	disposeTree(loaded.gltf.scene);
	return { bytes, report, text: formatReport(report, { normalisedFrom }), png, normalisedFrom };
}
