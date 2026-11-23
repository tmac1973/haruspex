/**
 * `REPORT-sequence.md`: what a run made, for the person who comes back to
 * it. Sections and their clips (seeds, flagged checks), the joins, the
 * sound, where the project and the render are, the render's own check, and
 * every note the run made on the way.
 */
import type { RenderResult } from '#lib/ipc/gen/RenderResult.ts';
import type { ClipPlan } from '#lib/sequence/spec/plan.ts';
import type { ClipProgress } from '#lib/sequence/spec/progress.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';

export interface ReportInput {
	spec: SequenceSpec;
	plan: ClipPlan;
	clips: Record<string, ClipProgress>;
	project: string | null;
	render: RenderResult | null;
	music: { id: string; file: string }[];
	narration: { id: string; file: string }[];
	notes: string[];
	startedMs: number;
	finishedMs: number;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function duration(ms: number): string {
	const min = Math.round(ms / 60000);
	return min < 60 ? plural(min, 'minute') : `${Math.floor(min / 60)} h ${min % 60} min`;
}

function joinText(j: SequenceSpec['joins'][number]): string {
	if (j.kind === 'crossfade') return `a ${j.secs ?? 1} s crossfade`;
	return j.kind === 'transition' ? 'a generated transition' : 'a hard cut';
}

function sectionLines(input: ReportInput): string[] {
	const { spec, plan, clips } = input;
	const out: string[] = [];
	spec.sections.forEach((s, k) => {
		if (k > 0) out.push('', `Then ${joinText(spec.joins[k - 1])}.`, '');
		if (s.kind === 'existing') {
			out.push(
				`### ${s.id}: existing clip`,
				'',
				`${s.path}${s.in_secs !== undefined ? ` from ${s.in_secs} s` : ''}.`
			);
			return;
		}
		const items = plan.items.filter((i) => i.section === s.id && i.kind === 'generate' && !i.join);
		out.push(`### ${s.id}: ${s.seconds} s, ${plural(items.length, 'clip')}`, '', s.prompt, '');
		for (const item of items) {
			const c = clips[item.id];
			const flag = c?.check && !c.check.ok ? ` — **flagged:** ${c.check.problem}` : '';
			out.push(`- ${item.id}: ${c?.file ?? 'not made'}, seed ${c?.seed ?? '—'}${flag}`);
		}
	});
	return out;
}

function renderLines(render: RenderResult | null): string[] {
	if (!render) return ['Not rendered.'];
	const lines = [`Rendered to ${render.path}.`];
	const c = render.check;
	if (c) {
		const loud = c.loudness ? `, ${c.loudness.lufs.toFixed(1)} LUFS` : '';
		lines.push(
			`${c.durationSecs.toFixed(1)} s, ${c.width}×${c.height} at ${c.fps} fps${c.hasAudio ? '' : ', no sound'}${loud}.`,
			...c.problems.map((p) => `- ${p}`)
		);
	}
	return lines;
}

export function renderSequenceReport(input: ReportInput): string {
	const { spec } = input;
	const flagged = Object.entries(input.clips).filter(([, c]) => c.check && !c.check.ok);
	const sound = [
		spec.sound.clip_sound ? 'the clips’ own sound' : 'the clips’ own sound muted',
		...input.music.map((m) => `music ${m.id} (${m.file})`),
		input.narration.length
			? `${plural(input.narration.length, 'narration line')} in narration/`
			: ''
	].filter(Boolean);
	return [
		`# ${spec.title}`,
		'',
		spec.style,
		'',
		`Made in ${duration(input.finishedMs - input.startedMs)}. ${plural(input.plan.items.filter((i) => i.kind === 'generate').length, 'clip')} at ${input.plan.width}×${input.plan.height}, ${input.plan.fps} fps${flagged.length ? `; ${flagged.length} failed the seam check twice and ${flagged.length === 1 ? 'was' : 'were'} kept` : ''}.`,
		'',
		'## Sections',
		'',
		...sectionLines(input),
		'',
		'## Sound',
		'',
		`${sound.join('; ')}.`,
		'',
		'## Project and render',
		'',
		input.project ? `The project is ${input.project}.` : 'No project was made.',
		...renderLines(input.render),
		...(input.notes.length ? ['', '## Notes', '', ...input.notes.map((n) => `- ${n}`)] : []),
		''
	].join('\n');
}
