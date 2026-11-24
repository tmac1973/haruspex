/**
 * The Video sequence run: from a brief to one rendered video.
 *
 * Ten stages, declared here so their indices never move as later phases fill
 * them in: Interview, Spec, Speech, Keyframes, Generate, Check, Sound,
 * Assemble, Render, Report. This phase builds the first two: an optional
 * interview, then a spec the model writes through a forced tool call, which
 * the runner validates against the video instance and writes to
 * `<episode>/sequence.json`. Attended runs stop there to show it. The stages
 * after say they are not built yet.
 */
import { videoEntries } from '#lib/videogen/entries.ts';
import { invoke } from '@tauri-apps/api/core';
import { normalizeAbort } from '#lib/utils/error.ts';
import {
	markRunStarted,
	markRunStepFinished,
	type JobRunStepStatus
} from '#lib/stores/jobRuns.svelte.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { RunStatus } from '#lib/agent/jobs/runner.svelte.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import { askUserQuestion } from '#lib/stores/userQuestion.svelte.ts';
import { stepsOf, type Steps } from '#lib/agent/jobs/types/video-sequence/steps.ts';
import { keyframesStage } from '#lib/agent/jobs/types/video-sequence/keyframesStage.ts';
import { generateStage } from '#lib/agent/jobs/types/video-sequence/generateStage.ts';
import { checkStage } from '#lib/agent/jobs/types/video-sequence/checkStage.ts';
import { finishStages } from '#lib/agent/jobs/types/video-sequence/finishStages.ts';
import { runFiles } from '#lib/agent/jobs/types/video-sequence/files.ts';
import { openInEditor } from '#lib/code/openEditor.ts';
import { createdScope, trackWrite } from '#lib/agent/tools/_created.ts';
import { refreshVideoBinaries, videoToolsOn } from '#lib/video/binaries.ts';
import { parseSequenceSpec } from '#lib/sequence/spec/parse.ts';
import { validateSequenceSpec, type Validated } from '#lib/sequence/spec/validate.ts';
import { planClips } from '#lib/sequence/spec/plan.ts';
import { estimateRun } from '#lib/sequence/spec/estimate.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';
import {
	parseConfig,
	specPathFor,
	type VideoSequenceConfig
} from '#lib/agent/jobs/types/video-sequence/config.ts';
import {
	buildSpecContext,
	type SpecContext
} from '#lib/agent/jobs/types/video-sequence/context.ts';
import {
	SUBMIT_SEQUENCE_SPEC_TOOL,
	submitted
} from '#lib/agent/jobs/types/video-sequence/tools.ts';
import {
	interviewPrompt,
	reviseUserMessage,
	specPrompt,
	specRetryPrompt,
	specSummary
} from '#lib/agent/jobs/types/video-sequence/prompts.ts';

export * from '#lib/agent/jobs/types/video-sequence/stages.ts';
import { INTERVIEW, SPEC } from '#lib/agent/jobs/types/video-sequence/stages.ts';
import { speechStage } from '#lib/agent/jobs/types/video-sequence/speechStage.ts';

/** One try and two retries with the problems quoted, then the stage fails. */
export const MAX_DERIVE_ATTEMPTS = 3;

/** How many changes the checkpoint takes before it stops offering more. */
const MAX_REVISIONS = 5;

const ASK = 'ask_user_question';
/** A spec the run can use, with what the checks changed. */
interface Checked {
	validated: Validated;
	summary: string;
}

/** The problems a spec's text has, or the checked spec. */
function check(json: unknown, sc: SpecContext, keyframes: boolean): Checked | string[] {
	const parsed = json === null ? null : parseSequenceSpec(json);
	if (!parsed?.spec) return parsed?.problems ?? ['No spec was submitted — call the tool.'];
	const validated = validateSequenceSpec(parsed.spec, sc.validate);
	const problems = [...parsed.problems, ...validated.errors];
	if (problems.length) return problems;
	const speaking = sc.speaking ? { limits: sc.speaking.caps.limits } : undefined;
	const plan = planClips(validated.spec, sc.video.caps, keyframes, speaking);
	const estimate = estimateRun(plan, null, validated.spec);
	return { validated, summary: specSummary(validated.spec, plan, estimate, validated.notes) };
}

/** Whether a generated section can open on a keyframe in this run. */
function usesKeyframes(sc: SpecContext): boolean {
	return sc.validate.imageBackend && sc.validate.capabilities.includes('start_image');
}

async function readText(workdir: string, relPath: string): Promise<string | null> {
	try {
		return await invoke<string>('fs_read_text_full', { workdir, relPath });
	} catch {
		return null;
	}
}

/**
 * What a run needs before it starts, or why it can't. `made` is a note for
 * the first step when the episode folder had to be made.
 */
async function preflight(
	ctx: JobRunContext,
	cfg: VideoSequenceConfig
): Promise<{ sc: SpecContext; made: string }> {
	const workdir = ctx.job.working_dir;
	if (!workdir) throw new Error('No working folder: the job needs the folder the video goes in.');
	await refreshVideoBinaries().catch(() => null);
	if (!videoToolsOn()) {
		throw new Error('The video tools are off: turn them on in Settings → Video editing.');
	}
	if (videoEntries().length === 0) {
		throw new Error('No video generation is set up: Settings → Video generation.');
	}
	// The job writes a new episode, so a missing folder is made, not refused.
	const made = cfg.episode_dir
		? await invoke<boolean>('video_episode_ensure', {
				workingDir: workdir,
				episode: cfg.episode_dir
			})
		: false;
	const sc = await buildSpecContext(workdir, cfg, ctx.abort.signal);
	return { sc, made: made ? `Made the episode folder ${cfg.episode_dir}. ` : '' };
}

/** The Interview stage: what the user decided, '' when nothing was asked. */
async function interviewStage(
	ctx: JobRunContext,
	steps: Steps,
	cfg: VideoSequenceConfig,
	sc: SpecContext,
	run: { attended: boolean; existing: string | null; specPath: string; made: string }
): Promise<string> {
	steps.start(INTERVIEW);
	steps.abortIfCancelled();
	if (run.existing !== null) {
		steps.finish(INTERVIEW, `${run.made}Skipped: ${run.specPath} is already written.`);
		return '';
	}
	if (!run.attended) {
		steps.finish(
			INTERVIEW,
			`${run.made}Skipped: the run is unattended, so the spec comes from the brief alone.`
		);
		return '';
	}
	const answers = await interview(ctx, cfg, sc);
	steps.finish(INTERVIEW, `${run.made}${answers || 'Nothing was asked: the brief settles it.'}`);
	return answers;
}

/** The Spec stage: read or write `sequence.json`, and stop to show it when attended. */
async function specStage(
	ctx: JobRunContext,
	steps: Steps,
	cfg: VideoSequenceConfig,
	sc: SpecContext,
	run: { attended: boolean; existing: string | null; specPath: string; answers: string }
): Promise<Checked> {
	steps.start(SPEC);
	steps.abortIfCancelled();
	const keyframes = usesKeyframes(sc);
	let checked: Checked;
	let wrote = run.existing === null;
	if (run.existing !== null) {
		const got = check(run.existing, sc, keyframes);
		if (Array.isArray(got)) {
			throw new Error(`The spec at ${run.specPath} has problems:\n${got.join('\n')}`);
		}
		checked = got;
	} else {
		checked = await derive(ctx, cfg, sc, keyframes, run.answers);
	}
	if (run.attended) {
		const after = await checkpoint(ctx, run.specPath, sc, keyframes, checked);
		wrote ||= after !== checked;
		checked = after;
	}
	if (wrote) await writeSpec(ctx, run.specPath, checked.validated.spec);
	steps.finish(SPEC, `${wrote ? 'Wrote' : 'Read'} ${run.specPath}.\n\n${checked.summary}`);
	return checked;
}

async function writeSpec(ctx: JobRunContext, specPath: string, spec: SequenceSpec): Promise<void> {
	const workdir = ctx.job.working_dir;
	const content = `${JSON.stringify(spec, null, 2)}\n`;
	await trackWrite(createdScope({ jobRunId: ctx.runId }), workdir, specPath, true, () =>
		invoke('fs_write_text', { workdir, relPath: specPath, content, overwrite: true })
	);
}

export async function runVideoSequencePipeline(ctx: JobRunContext): Promise<void> {
	const cfg = parseConfig(ctx.job.type_config);
	const specPath = specPathFor(cfg);
	// A chained or scheduled run has nobody to ask, whatever the config says.
	const attended = ctx.trigger === 'manual' && cfg.run_mode === 'attended';
	const steps = stepsOf(ctx);
	const startedMs = Date.now();
	void markRunStarted(ctx.runId, startedMs);
	try {
		const { sc, made: madeNote } = await preflight(ctx, cfg);
		const existing = await readText(ctx.job.working_dir!, specPath);
		const run = { attended, existing, specPath };
		const answers = await interviewStage(ctx, steps, cfg, sc, { ...run, made: madeNote });
		const { validated } = await specStage(ctx, steps, cfg, sc, { ...run, answers });
		const spec = validated.spec;
		const draws = usesKeyframes(sc);
		const files = runFiles(ctx, cfg);
		const plan = await speechStage(ctx, steps, files, {
			spec,
			video: sc.video,
			draws,
			speaking: sc.speaking
		});
		const stills = await keyframesStage(ctx, steps, cfg, files, { spec, plan, draws, attended });
		const genRun = {
			spec,
			plan,
			limits: sc.validate.limits,
			keyframes: draws,
			stills,
			attended,
			models: sc,
			writeSpec: (next: SequenceSpec) => writeSpec(ctx, specPath, next)
		};
		const made = await generateStage(ctx, steps, cfg, files, genRun);
		await checkStage(ctx, steps, cfg, files, { ...genRun, spec: made.spec, plan: made.plan });
		await finishStages(ctx, steps, cfg, files, {
			spec: made.spec,
			plan: made.plan,
			episodeClips: sc.clips,
			notes: validated.notes,
			startedMs
		});
		ctx.finalizeRun('succeeded', null);
	} catch (e) {
		const { aborted, msg } = normalizeAbort(e);
		const stepStatus: JobRunStepStatus = aborted ? 'cancelled' : 'failed';
		const at = Date.now();
		const idx = ctx.liveStepIndex();
		ctx.patchStep(idx, { status: stepStatus, error: msg, finishedAt: at });
		void markRunStepFinished(ctx.runId, idx, stepStatus, null, msg, at);
		const status: RunStatus = aborted ? 'cancelled' : 'failed';
		ctx.finalizeRun(status, aborted ? null : msg);
	} finally {
		ctx.onSettled();
	}
}

/** One interview turn; what was asked and answered, as text for the spec turn. */
async function interview(
	ctx: JobRunContext,
	cfg: VideoSequenceConfig,
	sc: SpecContext
): Promise<string> {
	const qa: string[] = [];
	const base = ctx.buildStreamCallbacks(INTERVIEW);
	const result = await ctx.runJobTurn({
		turnKind: 'sequence.interview',
		userMessage: 'Ask what the brief leaves open, one question at a time.',
		systemPrompt: interviewPrompt(cfg.brief, sc.text),
		contextSize: ctx.contextSize(),
		visionSupported: ctx.visionSupported(),
		maxIterations: 20,
		interactive: true,
		toolAllowlist: [ASK],
		...base,
		onToolEnd: (call, result, ...rest) => {
			if (call.name === ASK) {
				const q = (call.arguments as { question?: unknown })?.question;
				qa.push(`Q: ${typeof q === 'string' ? q : '(a question)'}\nA: ${result}`);
			}
			base.onToolEnd?.(call, result, ...rest);
		}
	});
	const decided = result.finalText?.trim() ?? '';
	return [...qa, ...(decided ? [decided] : [])].join('\n\n');
}

/** One spec turn: the submission's arguments, or null when nothing was submitted. */
async function specTurn(
	ctx: JobRunContext,
	systemPrompt: string,
	userMessage: string
): Promise<unknown> {
	let captured: unknown = null;
	const base = ctx.buildStreamCallbacks(SPEC);
	await ctx.runJobTurn({
		turnKind: 'sequence.spec',
		userMessage,
		systemPrompt,
		contextSize: ctx.contextSize(),
		visionSupported: ctx.visionSupported(),
		maxIterations: 6,
		toolAllowlist: [SUBMIT_SEQUENCE_SPEC_TOOL],
		forceFinalTool: SUBMIT_SEQUENCE_SPEC_TOOL,
		...base,
		onToolStart: (call: ResolvedToolCall) => {
			if (call.name === SUBMIT_SEQUENCE_SPEC_TOOL && call.arguments) captured = call.arguments;
			base.onToolStart?.(call);
		}
	});
	return captured;
}

/** Write a spec from the brief, retrying with the problems quoted. */
async function derive(
	ctx: JobRunContext,
	cfg: VideoSequenceConfig,
	sc: SpecContext,
	keyframes: boolean,
	answers: string,
	first = `Write the spec, then call ${SUBMIT_SEQUENCE_SPEC_TOOL}.`
): Promise<Checked> {
	const system = specPrompt(cfg.brief, answers, sc.text);
	let problems: string[] = [];
	let previous: unknown = null;
	for (let attempt = 0; attempt < MAX_DERIVE_ATTEMPTS; attempt++) {
		if (ctx.abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const message = attempt === 0 ? first : specRetryPrompt(problems, previous);
		const args = await specTurn(ctx, system, message);
		const got = check(submitted(args), sc, keyframes);
		if (!Array.isArray(got)) return withDefaultReanchor(got, args, cfg);
		problems = got;
		previous = args ?? previous;
	}
	throw new Error(
		`Could not write a usable spec after ${MAX_DERIVE_ATTEMPTS} attempts:\n${problems.join('\n')}`
	);
}

/** A submission that left `reanchor_every` out gets the job's value, not the spec default. */
function withDefaultReanchor(c: Checked, args: unknown, cfg: VideoSequenceConfig): Checked {
	const given = args && typeof args === 'object' && 'reanchor_every' in args;
	if (given || c.validated.spec.reanchor_every === 0) return c;
	c.validated.spec.reanchor_every = cfg.reanchor_every;
	return c;
}

/**
 * The Attended stop: the spec and its estimate, to approve, change, edit by
 * hand or stop. Returns the spec to go on with.
 */
async function checkpoint(
	ctx: JobRunContext,
	specPath: string,
	sc: SpecContext,
	keyframes: boolean,
	start: Checked
): Promise<Checked> {
	let checked = start;
	let problem = '';
	for (let round = 0; ; round++) {
		const more = round < MAX_REVISIONS;
		const answer = await askUserQuestion(
			{
				runId: ctx.runId,
				question: problem ? 'That change did not work. Approve this spec?' : 'Approve this spec?',
				body: `${problem ? `${problem}\n\n` : ''}${checked.summary}`,
				options: [
					{ label: 'Approve', description: 'Go on with this spec.', recommended: true },
					...(more
						? [{ label: 'Change it', description: 'Say what to change in the box below.' }]
						: []),
					{ label: 'Edit the file', description: `Open ${specPath} to change it by hand.` },
					{ label: 'Stop', description: 'End the run.' }
				]
			},
			ctx.abort.signal
		);
		problem = '';
		const choice = answer.kind === 'selected' ? answer.labels[0] : 'Change it';
		const note = answer.kind === 'freeText' ? answer.text.trim() : (answer.note?.trim() ?? '');
		if (choice === 'Approve') return checked;
		if (choice === 'Edit the file') {
			checked = await editByHand(ctx, specPath, sc, keyframes, checked);
			continue;
		}
		if (choice === 'Change it' && more) {
			const revised = note
				? await revise(ctx, sc, keyframes, checked, note)
				: 'Say what to change in the box under the options.';
			if (typeof revised === 'string') problem = revised;
			else checked = revised;
			continue;
		}
		throw new DOMException('Aborted', 'AbortError');
	}
}

/** The spec changed as the user asked, or what went wrong. */
async function revise(
	ctx: JobRunContext,
	sc: SpecContext,
	keyframes: boolean,
	checked: Checked,
	note: string
): Promise<Checked | string> {
	const args = await specTurn(
		ctx,
		specPrompt('', '', sc.text),
		reviseUserMessage(checked.validated.spec, note)
	);
	const got = check(submitted(args), sc, keyframes);
	return Array.isArray(got) ? got.map((p) => `- ${p}`).join('\n') : got;
}

/** Write the spec out, open it, and read it back once the user says they're done. */
async function editByHand(
	ctx: JobRunContext,
	specPath: string,
	sc: SpecContext,
	keyframes: boolean,
	checked: Checked
): Promise<Checked> {
	const workdir = ctx.job.working_dir!;
	const content = `${JSON.stringify(checked.validated.spec, null, 2)}\n`;
	await invoke('fs_write_text', { workdir, relPath: specPath, content, overwrite: true });
	const opened = await openInEditor(workdir, [specPath]);
	for (;;) {
		const answer = await askUserQuestion(
			{
				runId: ctx.runId,
				question: opened.ok
					? `Save ${specPath} in the editor window, then say when you're done.`
					: `Edit ${specPath}, save it, then say when you're done.`,
				options: [
					{ label: 'Done', description: 'Read the file again.', recommended: true },
					{ label: 'Stop', description: 'End the run.' }
				]
			},
			ctx.abort.signal
		);
		if (answer.kind !== 'selected' || answer.labels[0] !== 'Done') {
			throw new DOMException('Aborted', 'AbortError');
		}
		const text = await readText(workdir, specPath);
		const got = check(text, sc, keyframes);
		if (!Array.isArray(got)) return got;
		await askUserQuestion(
			{
				runId: ctx.runId,
				question: `${specPath} has problems. Fix them and save again.`,
				body: got.map((p) => `- ${p}`).join('\n'),
				options: [{ label: 'OK', description: 'Edit it again.' }]
			},
			ctx.abort.signal
		);
	}
}
