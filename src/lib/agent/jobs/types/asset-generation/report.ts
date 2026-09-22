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
import type { AnchorOutcome, EntryOutcome } from './types';

export interface ReportInput {
	spec: AssetSpec;
	specPath: string;
	anchor: AnchorOutcome | null;
	entries: EntryOutcome[];
	reports: Map<string, CheckReport | null>;
	/** Relative path of the contact sheet, or null when none was made. */
	contactSheet: string | null;
	/** Set when the judge was wanted but the model could not see. */
	judgeSkipped: boolean;
	/** What is known about what may be done with the output. */
	licensing: Licensing;
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
	return `${how}, ${who}. Palette: ${anchor.paletteSize} colour(s). Recipe: \`${anchor.recipePath}\`.`;
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
			`${e.reason ?? 'no reason recorded'}.${closest}` +
			(entry ? `\n  Nothing was written to \`${entry.out}\`.` : '')
		);
	});
	return ['## Not produced', '', ...lines, ''];
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

	lines.push('## Assets', '', ...entryTable(input), '');
	lines.push(...unresolvedSection(input));
	lines.push(...degradedSection(input));
	lines.push(...licensingSection(input.licensing));
	return lines.join('\n');
}
