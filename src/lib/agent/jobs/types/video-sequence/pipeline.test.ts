/**
 * The Video sequence run up to its spec, driven whole: the runner's context
 * (whose `runJobTurn` is the model), the file system, the video instance and
 * the user's answers are stand-ins; the pipeline, prompts, parser and
 * validator are real.
 */
import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { LTX, LTX_CAPS, foxSpec } from '#lib/testing/sequenceSpecs.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import type { RunStepState, RunTrigger } from '#lib/agent/jobs/runner.svelte.ts';
import type { EphemeralTurnResult } from '#lib/agent/runEphemeralTurn.ts';
import type { UserAnswer, UserQuestionRequest } from '#lib/stores/userQuestion.svelte.ts';
import { INTERVIEW, MAX_DERIVE_ATTEMPTS, REPORT, SPEC, runVideoSequencePipeline } from './pipeline';
import { SUBMIT_SEQUENCE_SPEC_TOOL } from './tools';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: { videoGenBackendKind: 'llama-toolchest' },
		overDefaults: true
	})
);
const env = vi.hoisted(() => ({ videoTools: true }));
vi.mock('#lib/video/binaries.ts', () => ({
	refreshVideoBinaries: async () => null,
	videoToolsOn: () => env.videoTools,
	videoOverrides: () => ({})
}));
vi.mock('#lib/videogen/toolchest.ts', () => ({
	readyVideoInstance: async () => ({
		id: 'ltx',
		capabilities: LTX_CAPS,
		state: 'running',
		video: LTX
	})
}));
vi.mock('#lib/image/backend.ts', () => ({ resolveImageBackend: () => ({ kind: 'comfyui' }) }));
vi.mock('#lib/music/backend.ts', () => ({ resolveMusicBackend: () => ({ kind: 'toolchest' }) }));
const asked = vi.hoisted(() => ({
	questions: [] as UserQuestionRequest[],
	answers: [] as UserAnswer[]
}));
vi.mock('#lib/stores/userQuestion.svelte.ts', () => ({
	askUserQuestion: async (q: UserQuestionRequest) => {
		asked.questions.push(q);
		const a = asked.answers.shift();
		if (!a) throw new DOMException('Aborted', 'AbortError');
		return a;
	}
}));
const opened = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock('#lib/code/openEditor.ts', () => ({
	openInEditor: async (_root: string, files: string[]) => {
		opened.files.push(...files);
		return { ok: true, opens: [], summary: '' };
	}
}));
vi.mock('#lib/stores/jobRuns.svelte.ts', () => ({
	markRunStarted: async () => {},
	markRunStepStarted: async () => {},
	markRunStepFinished: async () => {}
}));

let files: Map<string, string>;

function routes() {
	return invokeRouter({
		fs_read_text_full: (a) => {
			const v = files.get(a!.relPath as string);
			if (v === undefined) throw 'missing';
			return v;
		},
		fs_write_text: (a) => {
			files.set(a!.relPath as string, a!.content as string);
		},
		fs_list_dir: () => ({ entries: [] }),
		video_probe_folder: () => ({ clips: [], unreadable: [], introCandidates: [] })
	});
}

type Opts = Parameters<JobRunContext['runJobTurn']>[0];

interface Harness {
	ctx: JobRunContext;
	steps: Array<Partial<RunStepState>>;
	finished: { status: string; error: string | null } | null;
	turns: Opts[];
}

/** A run of a job whose model answers each turn with `turn`. */
function harness(
	config: Record<string, unknown>,
	turn: (opts: Opts, n: number) => unknown,
	trigger: RunTrigger = 'manual'
): Harness {
	const h: Harness = {
		steps: Array.from({ length: 10 }, () => ({})),
		finished: null,
		turns: [],
		ctx: null as unknown as JobRunContext
	};
	let current = 0;
	const job = {
		id: 7,
		name: 'Fox',
		working_dir: '/videos',
		type_config: JSON.stringify({
			episode_dir: 'ep1',
			brief: 'a fox, snow then forest',
			...config
		}),
		steps: []
	} as unknown as JobWithSteps;
	h.ctx = {
		job,
		runId: 9,
		abort: new AbortController(),
		trigger,
		runJobTurn: async (opts) => {
			h.turns.push(opts);
			const args = turn(opts, h.turns.length);
			if (args && opts.forceFinalTool) {
				opts.onToolStart?.({ id: 'c', name: opts.forceFinalTool, arguments: args as never });
			}
			return { finalText: '', rawText: '' } as EphemeralTurnResult;
		},
		patchStep: (i, p) => Object.assign(h.steps[i], p),
		buildStreamCallbacks: () => ({}),
		setCurrentStepIndex: (i) => (current = i),
		liveStepIndex: () => current,
		stepAuthored: () => '',
		isLive: () => true,
		contextSize: () => 32768,
		visionSupported: () => false,
		describeModel: () => ({ label: 'x', vision: false, contextSize: 32768 }),
		finalizeRun: (status, error) => (h.finished = { status, error }),
		onSettled: () => {},
		startChainedRun: async () => null,
		setResult: async () => {}
	};
	return h;
}

/** What the model submits: the fox spec without its version. */
function foxArgs(): Record<string, unknown> {
	const { version: _, ...rest } = foxSpec();
	void _;
	return rest;
}

beforeEach(() => {
	files = new Map();
	asked.questions = [];
	asked.answers = [];
	opened.files = [];
	env.videoTools = true;
	vi.mocked(invoke).mockImplementation(routes());
});

describe('the Video sequence run', () => {
	it('writes the spec from a full brief with no interview when unattended', async () => {
		const h = harness({ run_mode: 'unattended' }, () => foxArgs());
		await runVideoSequencePipeline(h.ctx);
		expect(h.finished).toEqual({ status: 'succeeded', error: null });
		expect(h.turns).toHaveLength(1);
		expect(h.turns[0].forceFinalTool).toBe(SUBMIT_SEQUENCE_SPEC_TOOL);
		expect(h.turns[0].systemPrompt).toContain('a fox, snow then forest');
		expect(h.turns[0].systemPrompt).toContain('Its longest clip is 5.0 s');
		expect(JSON.parse(files.get('ep1/sequence.json')!)).toEqual(foxSpec());
		expect(h.steps[INTERVIEW].output).toMatch(/Skipped: the run is unattended/);
		expect(h.steps[SPEC].output).toMatch(/^Wrote ep1\/sequence.json/);
		expect(h.steps[SPEC].output).toContain('unknown until the first clip');
		expect(h.steps[REPORT].output).toBe('Not built yet.');
		expect(asked.questions).toEqual([]);
	});

	it('gives a first bad spec its problems back, and its last spec', async () => {
		const h = harness({ run_mode: 'unattended' }, (_, n) =>
			n === 1
				? { ...foxArgs(), sections: [{ kind: 'existing', id: 'x', path: 'gone.mp4' }], joins: [] }
				: foxArgs()
		);
		await runVideoSequencePipeline(h.ctx);
		expect(h.finished?.status).toBe('succeeded');
		expect(h.turns).toHaveLength(2);
		expect(h.turns[1].userMessage).toContain('Section x: gone.mp4 is not in the episode folder.');
		expect(h.turns[1].userMessage).toContain('Your last spec:');
	});

	it('fails after the last attempt, naming the problems', async () => {
		const h = harness({ run_mode: 'unattended' }, () => ({ title: 'x' }));
		await runVideoSequencePipeline(h.ctx);
		expect(h.turns).toHaveLength(MAX_DERIVE_ATTEMPTS);
		expect(h.finished?.status).toBe('failed');
		expect(h.finished?.error).toMatch(/Could not write a usable spec after 3 attempts/);
		expect(files.has('ep1/sequence.json')).toBe(false);
	});

	it('reads a spec already in the episode folder and writes no new one', async () => {
		files.set('ep1/sequence.json', JSON.stringify(foxSpec()));
		const h = harness({ run_mode: 'unattended' }, () => {
			throw new Error('no turn should run');
		});
		await runVideoSequencePipeline(h.ctx);
		expect(h.finished?.status).toBe('succeeded');
		expect(h.turns).toEqual([]);
		expect(h.steps[SPEC].output).toMatch(/^Read ep1\/sequence.json/);
	});

	it('stops on a spec already there that has problems', async () => {
		files.set('ep1/sequence.json', JSON.stringify({ ...foxSpec(), joins: [] }));
		const h = harness({ run_mode: 'unattended' }, () => null);
		await runVideoSequencePipeline(h.ctx);
		expect(h.finished?.status).toBe('failed');
		expect(h.finished?.error).toMatch(/has problems:\njoins: 2 sections need 1 joins/);
	});

	it('interviews when attended, then asks at the checkpoint; Stop cancels', async () => {
		asked.answers = [{ kind: 'selected', labels: ['Stop'] }];
		const h = harness({}, () => foxArgs());
		await runVideoSequencePipeline(h.ctx);
		expect(h.turns[0].toolAllowlist).toEqual(['ask_user_question']);
		expect(h.turns[0].interactive).toBe(true);
		expect(h.turns[1].forceFinalTool).toBe(SUBMIT_SEQUENCE_SPEC_TOOL);
		expect(asked.questions[0].question).toBe('Approve this spec?');
		expect(asked.questions[0].body).toContain('**snow** — 60 s, generated');
		expect(asked.questions[0].body).toContain('25 clips, 1 music bed');
		expect(h.finished).toEqual({ status: 'cancelled', error: null });
		expect(files.has('ep1/sequence.json')).toBe(false);
	});

	it('changes the spec as asked at the checkpoint, then writes it on Approve', async () => {
		asked.answers = [
			{ kind: 'freeText', text: 'make the forest 30 seconds' },
			{ kind: 'selected', labels: ['Approve'] }
		];
		const shorter = foxArgs();
		(shorter.sections as { seconds: number }[])[1].seconds = 30;
		const h = harness({}, (opts) =>
			opts.userMessage.includes('make the forest 30 seconds') ? shorter : foxArgs()
		);
		await runVideoSequencePipeline(h.ctx);
		expect(h.finished?.status).toBe('succeeded');
		expect(JSON.parse(files.get('ep1/sequence.json')!).sections[1].seconds).toBe(30);
		expect(asked.questions[1].body).toContain('**forest** — 30 s');
	});

	it('opens the file to edit by hand, and reads back what was saved', async () => {
		asked.answers = [
			{ kind: 'selected', labels: ['Edit the file'] },
			{ kind: 'selected', labels: ['Done'] },
			{ kind: 'selected', labels: ['Approve'] }
		];
		const h = harness({}, () => foxArgs());
		vi.mocked(invoke).mockImplementation(
			invokeRouter({
				...Object.fromEntries(
					['fs_read_text_full', 'fs_list_dir', 'video_probe_folder'].map((k) => [
						k,
						(a: Record<string, unknown> | undefined) => routes()(k, a)
					])
				),
				fs_write_text: (a) => {
					// The user's editor saves the forest at 45 s.
					const spec = JSON.parse(a!.content as string);
					spec.sections[1].seconds = 45;
					files.set(a!.relPath as string, JSON.stringify(spec));
				}
			})
		);
		await runVideoSequencePipeline(h.ctx);
		expect(opened.files).toEqual(['ep1/sequence.json']);
		expect(h.finished?.status).toBe('succeeded');
		expect(asked.questions[2].body).toContain('**forest** — 45 s');
	});

	it('needs the video tools on', async () => {
		env.videoTools = false;
		const h = harness({}, () => foxArgs());
		await runVideoSequencePipeline(h.ctx);
		expect(h.finished?.error).toMatch(/Settings → Video editing/);
	});

	it('never asks on a run nobody started by hand', async () => {
		const h = harness({}, () => foxArgs(), 'chained');
		await runVideoSequencePipeline(h.ctx);
		expect(h.finished?.status).toBe('succeeded');
		expect(asked.questions).toEqual([]);
		expect(h.turns).toHaveLength(1);
	});
});
