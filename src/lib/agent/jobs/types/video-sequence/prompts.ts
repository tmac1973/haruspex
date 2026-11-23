/**
 * The Video sequence job's prompts. Each turn does one thing: the interview
 * asks, the spec turn writes the spec through one forced call. Short and
 * concrete, so the 9B local model can follow them.
 */
import { SUBMIT_SEQUENCE_SPEC_TOOL } from '#lib/agent/jobs/types/video-sequence/tools.ts';
import type { ClipPlan } from '#lib/sequence/spec/plan.ts';
import type { RunEstimate } from '#lib/sequence/spec/estimate.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';

export const INTERVIEW_DONE = 'INTERVIEW DONE';

export function interviewPrompt(brief: string, context: string): string {
	return [
		'You are planning one long generated video with the user. They gave this brief:',
		'',
		brief,
		'',
		'What the run has to work with:',
		'',
		context,
		'',
		'Ask the user, ONE question at a time, only what the brief leaves open. The things a spec needs:',
		'- how long each section is (and so the whole video);',
		'- how each section joins the next: a hard cut, a crossfade, or a generated transition;',
		'- the sound: the clips’ own sound, music (and its style for which sections), narration (its words);',
		'- start pictures from the episode folder, if any;',
		'- existing clips from the episode folder to mix in, and where.',
		'',
		'The ONLY way to ask is to CALL the `ask_user_question` tool, with a `question` and 2–4 `options`, your recommended one first. Never ask in prose.',
		'Skip anything the brief already settles. If the user answers "proceed", stop asking.',
		`When nothing is left open, write a short list of what was decided and end with the line ${INTERVIEW_DONE}.`
	].join('\n');
}

export function specPrompt(brief: string, answers: string, context: string): string {
	return [
		'Write the spec for one long generated video.',
		'',
		`The brief:\n${brief}`,
		answers ? `\nWhat the user decided:\n${answers}` : '',
		'',
		`What the run has to work with:\n\n${context}`,
		'',
		'Rules:',
		'- Sections in order. A generated section has an id (a short lowercase slug), a prompt and its seconds. An existing section has an id and a path from the list above.',
		'- `style` is one line every clip shares: the subject, the look, the light. Do not repeat it in each prompt.',
		'- A prompt says what happens in that section: the subject, the action, the camera. Keep it to one or two sentences.',
		'- One join between each two sections.',
		'- Use only paths from the lists above. Do not make up files.',
		'- Only what the brief and the user asked for: no extra sections, no music or narration nobody asked for.',
		'',
		`Call ${SUBMIT_SEQUENCE_SPEC_TOOL} once with the whole spec.`
	]
		.filter((l) => l !== '')
		.join('\n');
}

export function specRetryPrompt(problems: string[], previous: unknown): string {
	const last = previous
		? ['Your last spec:', '```json', JSON.stringify(previous, null, 2), '```', '']
		: [];
	return [
		...last,
		'It could not be used. Fix exactly these, keep everything else, and submit the whole spec again:',
		...problems.map((p) => `- ${p}`),
		'',
		`Call ${SUBMIT_SEQUENCE_SPEC_TOOL}.`
	].join('\n');
}

export function reviseUserMessage(spec: SequenceSpec, change: string): string {
	return [
		'Here is the current spec:',
		'```json',
		JSON.stringify(spec, null, 2),
		'```',
		'',
		`The user wants this changed: ${change}`,
		'',
		`Change only that, and call ${SUBMIT_SEQUENCE_SPEC_TOOL} with the whole spec.`
	].join('\n');
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The spec in a few lines, for the checkpoint and the step output. */
export function specSummary(
	spec: SequenceSpec,
	plan: ClipPlan,
	estimate: RunEstimate,
	notes: string[]
): string {
	const sections = spec.sections.map((s, i) => {
		const join = i > 0 ? `${joinText(spec.joins[i - 1])} → ` : '';
		const what =
			s.kind === 'generated'
				? `${s.seconds} s, generated: ${s.prompt}`
				: `existing clip ${s.path}${s.in_secs !== undefined ? ` from ${s.in_secs} s` : ''}`;
		return `${i + 1}. ${join}**${s.id}** — ${what}`;
	});
	const sound = [
		spec.sound.clip_sound ? 'the clips’ own sound' : '',
		...spec.sound.music.map((m) => `music "${m.caption}" under ${m.sections.join(', ')}`),
		spec.sound.narration.length ? plural(spec.sound.narration.length, 'narration line') : ''
	].filter(Boolean);
	const lines = [
		`**${spec.title}** — ${spec.style}`,
		'',
		...sections,
		'',
		`Sound: ${sound.length ? sound.join('; ') : 'none'}.`,
		`${plan.width}×${plan.height} at ${plan.fps} fps; re-anchor ${spec.reanchor_every ? `every ${spec.reanchor_every} clips` : 'off'}.`,
		estimate.note
	];
	if (notes.length) lines.push('', ...notes.map((n) => `- ${n}`));
	return lines.join('\n');
}

function joinText(j: SequenceSpec['joins'][number] | undefined): string {
	if (!j || j.kind === 'cut') return 'cut';
	if (j.kind === 'crossfade') return `${j.secs ?? 1} s crossfade`;
	return 'transition';
}
