/**
 * A GLB report as the lines a model reads: problems first, then size, parts,
 * warnings, materials and clips. Long lists are cut so the whole stays short.
 */
import type { Bounds, GlbReport } from '#lib/glb/report.ts';

export interface FormatOptions {
	/** The bounds before normalisation, when the GLB was normalised. */
	normalisedFrom?: Bounds;
}

/** The text is kept under this many characters. */
export const MAX_REPORT_CHARS = 2500;
/** At most this many names from each list. */
const LIST_LIMIT = 20;

const m = (n: number) => n.toFixed(2);
const dims = (s: [number, number, number]) => `${m(s[0])} × ${m(s[1])} × ${m(s[2])} m`;

function list(names: string[], limit = LIST_LIMIT): string {
	const shown = names.slice(0, limit).join(', ');
	return names.length > limit ? `${shown} and ${names.length - limit} more` : shown;
}

function materialLine(r: GlbReport): string {
	const items = r.materials.map((mat) => {
		const bits = [mat.type];
		if (mat.color) bits.push(mat.color);
		if (mat.metalness !== null && mat.metalness > 0.5) bits.push(`metal ${m(mat.metalness)}`);
		if (mat.transparent) bits.push('transparent');
		if (mat.map) bits.push(`map ${mat.map[0]}×${mat.map[1]}`);
		return `${mat.name} (${bits.join(', ')})`;
	});
	return `Materials: ${list(items, 12)}.`;
}

function build(r: GlbReport, opts: FormatOptions, limit: number): string[] {
	const lines = r.problems.map((p) => `- ${p}`);
	const size = `Size: ${dims(r.bounds.size)} (x × y × z). Feet at y = ${m(r.feetY)}; centre offset x ${m(r.centreOffset[0])}, z ${m(r.centreOffset[1])}.`;
	lines.push(
		opts.normalisedFrom ? `${size} Normalised from ${dims(opts.normalisedFrom.size)}.` : size
	);
	const heavy = r.heaviest.map((h) => `${h.name} ${h.triangles}`).join(', ');
	lines.push(`${r.meshes} meshes, ${r.triangles} triangles.${heavy ? ` Heaviest: ${heavy}.` : ''}`);
	if (r.floating.length) lines.push(`Floating (touch nothing): ${list(r.floating, limit)}.`);
	if (r.buried.length) {
		const b = r.buried.map((x) => `${x.part} inside ${x.inside}`);
		lines.push(`Buried (may be hidden): ${list(b, limit)}.`);
	}
	if (r.outliers.length) lines.push(`Size outliers: ${list(r.outliers, limit)}.`);
	lines.push(...r.warnings.slice(0, limit).map((w) => `- ${w}`));
	if (r.warnings.length > limit) lines.push(`- and ${r.warnings.length - limit} more warnings.`);
	if (r.materials.length) lines.push(materialLine(r));
	lines.push(
		r.animations.length
			? `Animations: ${r.animations.map((a) => `${a.name} ${a.duration.toFixed(1)} s (${a.tracks} track${a.tracks === 1 ? '' : 's'})`).join(', ')}.`
			: 'No animation.'
	);
	return lines;
}

/** The report as text, under `MAX_REPORT_CHARS`. */
export function formatReport(r: GlbReport, opts: FormatOptions = {}): string {
	for (const limit of [LIST_LIMIT, 8, 3]) {
		const text = build(r, opts, limit).join('\n');
		if (text.length <= MAX_REPORT_CHARS || limit === 3) return text.slice(0, MAX_REPORT_CHARS);
	}
	return '';
}
