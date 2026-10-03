/**
 * The run's report: what was made, what was degraded, what could not be made.
 *
 * Rendered from the structured outcomes the stages recorded, never scraped
 * back out of their human-readable output. A report assembled from prose is a
 * report that can say something the run did not do — which is the failure
 * mode the whole quality gate exists to prevent, and it would be absurd to
 * reintroduce it in the document that reports on it.
 */

import type { CheckReport } from '$lib/ipc/gen/CheckReport';
import type { AssetSpec } from '$lib/assets/spec/types';
import { describeFailures } from './gate';
import type { AnchorOutcome, EntryOutcome, SheetOutcome } from './types';

export interface ReportInput {
	spec: AssetSpec;
	specPath: string;
	anchor: AnchorOutcome | null;
	entries: EntryOutcome[];
	reports: Map<string, CheckReport | null>;
	/** Every generation of every sheet, in order. Empty when nothing used one. */
	sheets?: SheetOutcome[];
	/** Relative path of the contact sheet, or null when none was made. */
	contactSheet: string | null;
	/** Set when the judge was wanted but the model could not see. */
	judgeSkipped: boolean;
	/** What is known about what may be done with the output. */
	licensing: Licensing;
	/** Set when `style.prompt` did not fit the text encoder's window. */
	styleTruncated: boolean;
	/**
	 * The edge assets were generated at, and the one the model was trained
	 * at. `nativeEdge` is null when the checkpoint is not one we know.
	 */
	sizing: { edge: number; nativeEdge: number | null };
	startedAt: number;
	finishedAt: number;
}

/**
 * What Haruspex knows about the licence of everything that shaped the output.
 *
 * `model` is null when the run used a checkpoint Haruspex did not provide —
 * a hand-placed file, or ComfyUI's own configured default. `loras` lists any
 * the spec named.
 */
export interface Licensing {
	modelName: string;
	modelLicense: string | null;
	loras: string[];
}

/**
 * The licensing section.
 *
 * Present in every report, including the boring case, because its job is to
 * say what is NOT known and an absent section reads as "nothing to worry
 * about". The LoRA line is the point: `AssetStyle.loras` lets a spec name
 * one, most published pixel-art LoRAs carry their own terms, and many were
 * trained on scraped commercial game art — so a LoRA can quietly contaminate
 * output whose base model is perfectly clean. Haruspex cannot classify a file
 * the user supplied, so it must not leave a clean base-model licence standing
 * for the whole result.
 */
function licensingSection(l: Licensing): string[] {
	const lines: string[] = ['## Licensing', ''];
	lines.push(
		l.modelLicense
			? `Model: **${l.modelName}** — ${l.modelLicense}`
			: `Model: **${l.modelName}** — licence unknown. Haruspex did not provide this ` +
					`checkpoint and cannot state what may be done with what it produces.`
	);
	lines.push('');
	if (l.loras.length > 0) {
		lines.push(
			`LoRAs: ${l.loras.map((n) => `\`${n}\``).join(', ')} — **licence unknown**.`,
			'',
			'A LoRA carries its own terms, separate from the base model, and many published',
			'ones were trained on art their author did not own. The licence above covers the',
			'checkpoint only; it says nothing about these.',
			''
		);
	}
	lines.push(
		'Generated images are generally not copyrightable in their own right. Some storefronts',
		'require AI-generated content to be disclosed.',
		''
	);
	return lines;
}

function countByStatus(entries: EntryOutcome[]) {
	const n = (s: EntryOutcome['status']) => entries.filter((e) => e.status === s).length;
	return {
		done: n('done'),
		skipped: n('skipped'),
		unresolved: n('unresolved'),
		failed: n('failed')
	};
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** The anchor line, from the structure — reused vs generated, approved vs not. */
function anchorLine(anchor: AnchorOutcome | null): string {
	if (!anchor) return 'No style anchor was established.';
	const how =
		anchor.source === 'reused'
			? `Reused the committed anchor at \`${anchor.imagePath}\``
			: `Generated in ${anchor.attempts} attempt(s) → \`${anchor.imagePath}\``;
	const who =
		anchor.approval === 'approved'
			? 'approved by a human'
			: 'accepted automatically — nobody saw it';
	const discarded =
		anchor.rejected > 0
			? ` ${anchor.rejected} earlier attempt(s) were discarded for a palette that had ` +
				`collapsed onto one colour — usually a sign the style prompt describes a scene ` +
				`rather than a subject.`
			: '';
	return (
		`${how}, ${who}. Palette: ${anchor.paletteSize} colour(s). ` +
		`Recipe: \`${anchor.recipePath}\`.${discarded}`
	);
}

function statusWord(s: EntryOutcome['status']): string {
	return { done: 'done', skipped: 'skipped', unresolved: 'unresolved', failed: 'failed' }[s];
}

/**
 * The per-entry table.
 *
 * Seed included because it is the only thing that makes one asset
 * reproducible, and duration because "which of these forty cost the twelve
 * minutes" is otherwise unanswerable.
 */
function entryTable(input: ReportInput): string[] {
	const byId = new Map(input.spec.entries.map((e) => [e.id, e]));
	const rows = input.entries.map((e) => {
		const entry = byId.get(e.id);
		const degraded = e.degraded.length > 0 ? e.degraded.join('; ') : '—';
		const seed = e.seed === null ? '—' : String(e.seed);
		return `| \`${e.id}\` | ${entry?.kind ?? '?'} | ${statusWord(e.status)} | ${e.attempts} | ${seed} | ${seconds(e.durationMs)} | ${degraded} |`;
	});
	return [
		'| Asset | Kind | Outcome | Attempts | Seed | Time | Degraded |',
		'| --- | --- | --- | --- | --- | --- | --- |',
		...rows
	];
}

/** A reason as a sentence: ends in exactly one stop, whatever it ended in. */
function sentence(text: string): string {
	return /[.?!]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

/**
 * One line for a cause shared by many: a backend that went away, or a full
 * disk, fails every asset after it the same way, and a list of thirty
 * identical reasons buries the one thing to fix.
 */
function commonCause(bad: ReportInput['entries']): string[] {
	const counts = new Map<string, number>();
	for (const e of bad) if (e.reason) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
	const [reason, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
	if (n < 3) return [];
	return [
		`**${n} of ${bad.length} failed for the same reason:** ${sentence(reason)} Fix that and run ` +
			'the job again; only the assets not on disk are generated.',
		''
	];
}

function unresolvedSection(input: ReportInput): string[] {
	const bad = input.entries.filter((e) => e.status === 'unresolved' || e.status === 'failed');
	if (bad.length === 0) return [];
	const lines = bad.map((e) => {
		const report = input.reports.get(e.id);
		const closest =
			report && report.failed.length > 0
				? ` Closest attempt still failed: ${describeFailures(report.failed)}.`
				: '';
		const entry = input.spec.entries.find((x) => x.id === e.id);
		return (
			`- **\`${e.id}\`** (${statusWord(e.status)}, ${e.attempts} attempt(s)) — ` +
			`${sentence(e.reason ?? 'no reason recorded')}${closest}` +
			(entry ? `\n  Nothing was written to \`${entry.out}\`.` : '')
		);
	});
	return ['## Not produced', '', ...commonCause(bad), ...lines, ''];
}

/**
 * Degradation, aggregated by layer.
 *
 * Forty identical lines saying "no reference conditioning" is how a reader
 * stops reading the report, so each missing layer is named once with the
 * entries it cost.
 */
function degradedSection(input: ReportInput): string[] {
	const byLayer = new Map<string, string[]>();
	for (const e of input.entries) {
		for (const d of e.degraded) byLayer.set(d, [...(byLayer.get(d) ?? []), e.id]);
	}
	if (byLayer.size === 0) return [];
	const lines = [...byLayer].map(
		([layer, ids]) =>
			`- **${layer}** — ${ids.length} asset(s): ${ids.map((i) => `\`${i}\``).join(', ')}`
	);
	return [
		'## Degraded',
		'',
		'Coherence layers the backend could not provide. These assets were still',
		'made, and they may not match the rest of the set as closely.',
		'',
		...lines,
		''
	];
}

/**
 * The sheets, generation by generation.
 *
 * The aggregate line leads with how many cut exactly, because that is the
 * number that says whether the sheet size suits this model: a run where most
 * sheets came back with subjects missing or touching is telling you to ask
 * for fewer per sheet.
 */
function sheetSection(sheets: SheetOutcome[]): string[] {
	if (sheets.length === 0) return [];
	const exact = sheets.filter((s) => s.exact).length;
	const keyed = sheets.filter((s) => s.keyed).length;
	const retries = sheets.filter((s) => s.round > 1).length;
	const lines = [
		'## Sheets',
		'',
		`**${exact} of ${sheets.length} sheet generation(s) cut exactly.** ` +
			`${retries} were retries of subjects an earlier sheet did not deliver.` +
			(keyed > 0
				? ` ${keyed} came back on an opaque backdrop, which was keyed rather than regenerated.`
				: ''),
		'',
		'| Sheet | Round | Subjects | Exact | Missing | Touching | Rejected | Keyed | Seed |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	];
	for (const s of sheets) {
		lines.push(
			`| \`${s.id}\` | ${s.round} | ${s.subjects.length} | ${s.exact ? 'yes' : 'no'} | ` +
				`${s.missing} | ${s.merged} | ${s.rejected} | ${s.keyed ? 'yes' : '—'} | ` +
				`${s.seed ?? '—'} |`
		);
	}
	lines.push('');
	return lines;
}

export function renderAssetReport(input: ReportInput): string {
	const t = countByStatus(input.entries);
	const total = input.entries.length;
	const lines: string[] = [
		'# Asset report',
		'',
		`Spec: \`${input.specPath}\` — ${total} asset(s), ` +
			`${seconds(input.finishedAt - input.startedAt)} total.`,
		'',
		`**${t.done} generated**, ${t.skipped} already present, ` +
			`${t.unresolved} unresolved, ${t.failed} failed.`,
		''
	];

	if (input.contactSheet) {
		lines.push('## Contact sheet', '');
		lines.push(
			'The set, side by side. Incoherence is only visible this way — one asset',
			'at a time always looks fine.',
			''
		);
		lines.push(`![Contact sheet](${input.contactSheet})`, '');
	}

	lines.push('## Style anchor', '', anchorLine(input.anchor), '');

	if (input.judgeSkipped) {
		// Once, not once per entry.
		lines.push(
			'The vision judge was enabled but this run’s model does not accept',
			'images, so every asset was accepted on the mechanical checks alone.',
			''
		);
	}

	const { edge, nativeEdge } = input.sizing;
	if (nativeEdge !== null && edge !== nativeEdge) {
		// Not corrected automatically: the spec is the user's file. But a
		// mismatch here is not a matter of taste — SDXL produces artefacts
		// below its native 1024 and SD1.5 degrades above its 512 — so it is
		// said plainly rather than left to be discovered in the output.
		lines.push(
			`Assets were generated at ${edge}px, but this model was trained at ` +
				`${nativeEdge}px. ${
					edge < nativeEdge
						? 'Generating below native resolution produces mush at these sizes.'
						: 'Generating above native resolution produces artefacts and duplicated subjects.'
				}`,
			`Set \`normalize.upscale\` to ${Math.max(1, Math.round(nativeEdge / (input.spec.normalize.target_size || 32)))} in the spec to match.`,
			''
		);
	}

	if (input.styleTruncated) {
		lines.push(
			'Your style prompt was longer than the text encoder accepts, so only its',
			'opening clauses were used. CLIP reads 77 tokens; past that the subject of',
			'the picture falls out of the window and the model renders the style alone.',
			'Shorten `style.prompt` to keep control of what is dropped — it should',
			'describe the medium and palette, not the subject or the camera.',
			''
		);
	}

	lines.push(...sheetSection(input.sheets ?? []));
	lines.push('## Assets', '', ...entryTable(input), '');
	lines.push(...unresolvedSection(input));
	lines.push(...degradedSection(input));
	lines.push(...licensingSection(input.licensing));
	return lines.join('\n');
}
