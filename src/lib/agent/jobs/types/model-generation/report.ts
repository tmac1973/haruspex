/**
 * `REPORT-models.md`: what a 3D models run made, written beside the spec.
 * Each model's state, its sheets and its open problems, so a model marked
 * needs work says why without anyone re-running the checker.
 */

import { modelFiles, REPORT_NAME } from '#lib/models3d/spec/paths.ts';
import type { ModelSpec } from '#lib/models3d/spec/types.ts';
import type { EntryState } from '#lib/agent/jobs/types/model-generation/state.ts';

/** The report lands beside the spec. */
export function modelsReportPath(specPath: string): string {
	const slash = specPath.lastIndexOf('/');
	return slash < 0 ? REPORT_NAME : `${specPath.slice(0, slash)}/${REPORT_NAME}`;
}

/** `to` as seen from the folder `fromDir` ('' = the working directory); both relative. */
export function relativePath(fromDir: string, to: string): string {
	const from = fromDir.split('/').filter(Boolean);
	const target = to.split('/').filter(Boolean);
	let shared = 0;
	while (shared < from.length && shared < target.length - 1 && from[shared] === target[shared]) {
		shared++;
	}
	return [...from.slice(shared).map(() => '..'), ...target.slice(shared)].join('/');
}

const STATE_WORD = {
	pending: 'not built',
	done: 'done',
	needs_work: 'needs work',
	skipped: 'skipped'
} as const;

/** A cell's text, safe inside a markdown table row. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Creation's and animation's problems together: what is open on the model. */
function openProblems(state: EntryState): string[] {
	return [...state.problems, ...(state.clips?.problems ?? [])];
}

export interface ModelReportInput {
	spec: ModelSpec;
	states: EntryState[];
	/** Where the report is written, so its image links resolve from there. */
	reportPath: string;
	createLabel: string;
	animateLabel: string;
}

/** The summary table, also the run's final output. */
export function modelReportTable(spec: ModelSpec, states: EntryState[]): string {
	const rows = spec.entries.map((e, i) => {
		const s = states[i];
		const problems = s.status === 'skipped' ? '' : openProblems(s).join(' ');
		return (
			`| ${cell(e.title)} | ${STATE_WORD[s.status]} | ${e.height_m} m | ` +
			`${e.parts.length > 0 ? cell(e.parts.join(', ')) : '—'} | ` +
			`${e.clips.length > 0 ? cell(e.clips.map((c) => c.name).join(', ')) : '—'} | ` +
			`${cell(problems) || '—'} |`
		);
	});
	return [
		'| Model | State | Height | Parts | Clips | Problems |',
		'|---|---|---|---|---|---|',
		...rows
	].join('\n');
}

export function renderModelReport(input: ModelReportInput): string {
	const { spec, states, reportPath } = input;
	const slash = reportPath.lastIndexOf('/');
	const reportDir = slash < 0 ? '' : reportPath.slice(0, slash);
	const link = (path: string) => relativePath(reportDir, path);

	const sections = spec.entries.flatMap((e, i) => {
		const s = states[i];
		const files = modelFiles(e);
		const out = ['', `## ${e.title} (\`${e.id}\`) — ${STATE_WORD[s.status]}`, ''];
		if (s.glb) out.push(`Model: [${e.id}.glb](${link(files.glb)})`, '');
		if (s.sheet) out.push(`![${e.title}](${link(files.sheet)})`, '');
		for (const name of s.clips?.sheets ?? []) {
			out.push(`![${e.title} — ${name}](${link(files.clipSheet(name))})`, '');
		}
		if (s.note) out.push(`Review note: ${s.note}`, '');
		const problems = s.status === 'skipped' ? [] : openProblems(s);
		if (problems.length > 0) out.push('Open problems:', '', ...problems.map((p) => `- ${p}`), '');
		if (s.warnings.length > 0) {
			out.push('Warnings:', '', ...s.warnings.map((w) => `- ${w}`), '');
		}
		return out;
	});

	return [
		'# 3D models report',
		'',
		`Built on ${input.createLabel}; animated on ${input.animateLabel}.`,
		'',
		modelReportTable(spec, states),
		...sections
	]
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trimEnd()
		.concat('\n');
}
