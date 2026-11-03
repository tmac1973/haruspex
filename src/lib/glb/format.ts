/**
 * A GLB report as the lines a model reads: problems first, then size, parts,
 * warnings, materials and clips. Long lists are cut so the whole stays short.
 */
import type { Bounds, GlbReport } from '#lib/glb/report.ts';

export interface FormatOptions {
	/** The bounds before normalisation, when the GLB was normalised. */
	normalisedFrom?: Bounds;
	/** The clip checks, one line per clip under a heading (`formatClipLines`). */
	clipLines?: string[];
	/** One clip's detail (`formatClip`), and that clip's name. */
	clipDetail?: string[];
	clip?: string;
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
	if (opts.clipLines?.length) lines.push(...opts.clipLines, ...(opts.clipDetail ?? []));
	else {
		lines.push(
			r.animations.length
				? `Animations: ${r.animations.map((a) => `${a.name} ${a.duration.toFixed(1)} s (${a.tracks} track${a.tracks === 1 ? '' : 's'})`).join(', ')}.`
				: 'No animation.'
		);
	}
	return lines;
}

/**
 * Drop clip lines from the end until `fits`, keeping the line for `keep`.
 * The heading stays, and a last line says how many were dropped.
 */
function trimClips(lines: string[], keep: string | undefined, fits: (l: string[]) => boolean) {
	const [heading, ...rest] = lines;
	const kept = [...rest];
	let dropped = 0;
	const withNote = () => [
		heading,
		...kept,
		...(dropped ? [`- and ${dropped} more clips (pass clip to check one).`] : [])
	];
	for (let i = kept.length - 1; i >= 0 && !fits(withNote()); i--) {
		if (keep !== undefined && kept[i].startsWith(`- ${keep} (`)) continue;
		kept.splice(i, 1);
		dropped++;
	}
	return withNote();
}

/** The report as text, under `MAX_REPORT_CHARS`; clip lines go before the rest is cut. */
export function formatReport(r: GlbReport, opts: FormatOptions = {}): string {
	let text = '';
	for (const limit of [LIST_LIMIT, 8, 3]) {
		text = build(r, opts, limit).join('\n');
		if (text.length <= MAX_REPORT_CHARS) return text;
	}
	if (opts.clipLines?.length) {
		const base = build(r, { ...opts, clipLines: undefined, clipDetail: undefined }, 3)
			.slice(0, -1)
			.join('\n');
		const detail = opts.clipDetail ?? [];
		const fits = (clips: string[]) =>
			[base, ...clips, ...detail].join('\n').length <= MAX_REPORT_CHARS;
		text = [base, ...trimClips(opts.clipLines, opts.clip, fits), ...detail].join('\n');
	}
	return text.slice(0, MAX_REPORT_CHARS);
}
