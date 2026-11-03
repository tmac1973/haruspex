/**
 * The 3D models run, driven whole through its spec and creation stages.
 *
 * Only the module boundaries are stand-ins: Tauri's `invoke` (an in-memory
 * working directory), `judgeModel` (the webview's checker) and the runner's
 * context, whose `runJobTurn` is the model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { parseModelSpec } from '#lib/models3d/spec/parse.ts';
import { renderModelSpec } from '#lib/models3d/spec/write.ts';
import { DEFAULT_MODELS_SPEC_PATH } from '#lib/models3d/spec/paths.ts';
import type { ModelSpec } from '#lib/models3d/spec/types.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import type { RunStepState } from '#lib/agent/jobs/runner.svelte.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import type { EphemeralTurnResult } from '#lib/agent/runEphemeralTurn.ts';
import { ANIMATE, CREATE, HANDOFF, REPORT, SPEC, runModelGenerationPipeline } from './pipeline';
import { SUBMIT_MODEL_SPEC_TOOL } from './tools';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
const verdict = vi.hoisted(() => ({ judgeModel: vi.fn() }));
vi.mock('#lib/glb/verdict.ts', () => ({ judgeModel: verdict.judgeModel }));
const question = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock('#lib/stores/userQuestion.svelte.ts', () => ({ askUserQuestion: question.ask }));
const jobs = vi.hoisted(() => ({ createJob: vi.fn() }));
vi.mock('#lib/stores/jobs.svelte.ts', () => ({ createJob: jobs.createJob }));

const SPEC_PATH = DEFAULT_MODELS_SPEC_PATH;

/** The working directory, as the fs commands see it. */
let files: Map<string, string>;
let written: string[];
/** Binary files the run wrote (GLBs, sheets). */
let bytesWritten: string[];

function routes() {
	return invokeRouter({
		fs_read_text_full: (a) => {
			const v = files.get(a!.relPath as string);
			if (v === undefined) throw `No such file: ${String(a!.relPath)}`;
			return v;
		},
		fs_write_text: (a) => {
			written.push(a!.relPath as string);
			files.set(a!.relPath as string, a!.content as string);
		},
		fs_read_bytes: (a) => {
			if (!files.has(a!.relPath as string)) throw `Not a file: ${String(a!.relPath)}`;
			return [1];
		},
		fs_write_bytes: (a) => {
			bytesWritten.push(a!.relPath as string);
		}
	});
}

function knightSpec(): ModelSpec {
	return {
		version: 1,
		style: 'low-poly, flat colours',
		entries: [
			{
				id: 'knight',
				title: 'Knight',
				description: 'An armoured knight.',
				height_m: 1.8,
				parts: ['Hip_L', 'Hip_R'],
				clips: [{ name: 'Walk', seconds: 1, loop: true, action: 'walks forward' }],
				dir: 'assets/generated/model/knight/'
			},
			{
				id: 'crate',
				title: 'Crate',
				description: 'A wooden crate.',
				height_m: 0.6,
				parts: [],
				clips: [],
				dir: 'assets/generated/model/crate/'
			}
		]
	};
}

/** What the model submits: titles, no ids or folders. */
const SUBMITTED = {
	style: 'low-poly, flat colours',
	entries: [
		{
			title: 'Knight',
			description: 'An armoured knight.',
			height_m: 1.8,
			parts: ['Hip_L', 'Hip_R'],
			clips: [{ name: 'Walk', seconds: 1, loop: true, action: 'walks forward' }]
		},
		{ title: 'Crate', description: 'A wooden crate.', height_m: 0.6 }
	]
};

type Turn = (opts: Parameters<JobRunContext['runJobTurn']>[0]) => ResolvedToolCall | null;

interface Harness {
	ctx: JobRunContext;
	steps: Array<Partial<RunStepState>>;
	finished: { status: string; error: string | null } | null;
	turns: Array<Parameters<JobRunContext['runJobTurn']>[0]>;
}

function harness(opts: { config?: Record<string, unknown>; turn?: Turn } = {}): Harness {
	const h: Harness = {
		steps: [{}, {}, {}, {}, {}],
		finished: null,
		turns: [],
		ctx: null as unknown as JobRunContext
	};
	let current = 0;
	const job = {
		id: 7,
		name: 'Arena models',
		working_dir: '/proj',
		type_config: JSON.stringify(opts.config ?? {}),
		steps: []
	} as unknown as JobWithSteps;
	h.ctx = {
		job,
		runId: 99,
		abort: new AbortController(),
		trigger: 'manual',
		runJobTurn: async (turnOpts) => {
			h.turns.push(turnOpts);
			// A creation turn writes its entry's build module.
			if (turnOpts.turnKind === 'models.create') {
				const id = /^Build: (\w+)/m.exec(turnOpts.userMessage)?.[1]?.toLowerCase();
				files.set(`assets/generated/model/${id}/${id}.js`, 'export default () => {}');
			}
			if (turnOpts.turnKind === 'models.animate') {
				const id = /^Animate: (\w+)/m.exec(turnOpts.userMessage)?.[1]?.toLowerCase();
				files.set(`assets/generated/model/${id}/${id}.anim.js`, 'export default () => []');
			}
			const call = opts.turn?.(turnOpts) ?? null;
			if (call) turnOpts.onToolStart?.(call);
			return {} as EphemeralTurnResult;
		},
		patchStep: (i, patch) => Object.assign(h.steps[i], patch),
		buildStreamCallbacks: () => ({}),
		setCurrentStepIndex: (i) => (current = i),
		liveStepIndex: () => current,
		stepAuthored: () => '',
		isLive: () => true,
		contextSize: () => 32768,
		visionSupported: () => false,
		describeModel: () => ({ label: 'Settings default', vision: false, contextSize: 32768 }),
		finalizeRun: (status, error) => (h.finished = { status, error }),
		onSettled: () => {},
		startChainedRun: async () => null,
		setResult: async () => {}
	};
	return h;
}

/** The turns that wrote the spec, not the creation turns after it. */
const deriveTurns = (h: Harness) => h.turns.filter((t) => t.turnKind === 'models.derive');

const submit = (args: Record<string, unknown>): ResolvedToolCall => ({
	id: 'c1',
	name: SUBMIT_MODEL_SPEC_TOOL,
	arguments: args
});

beforeEach(() => {
	vi.clearAllMocks();
	files = new Map();
	written = [];
	bytesWritten = [];
	tauri.invoke.mockImplementation(routes());
	question.ask.mockResolvedValue({ kind: 'selected', labels: ['Keep'] });
	verdict.judgeModel.mockResolvedValue({
		done: true,
		problems: [],
		warnings: [],
		text: '',
		sheetPng: 'data:image/png;base64,iVBORw0KGgo=',
		clipSheets: {},
		glb: new Uint8Array([1])
	});
});

describe('a run over an existing spec', () => {
	it('reads it, leaves it alone, and builds each entry', async () => {
		files.set(SPEC_PATH, renderModelSpec(knightSpec()));
		const h = harness();

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished).toEqual({ status: 'succeeded', error: null });
		expect(h.steps[SPEC]).toMatchObject({
			status: 'succeeded',
			output: `${SPEC_PATH} — 2 model(s), 1 animated (Walk)`
		});
		expect(deriveTurns(h)).toEqual([]);
		// Both built; only the knight has clips to animate.
		expect(h.turns.map((t) => t.turnKind)).toEqual([
			'models.create',
			'models.create',
			'models.animate'
		]);
		expect(files.get(SPEC_PATH)).toBe(renderModelSpec(knightSpec()));
		expect(written).toEqual(['assets/REPORT-models.md']);
		expect(bytesWritten).toEqual([
			'assets/generated/model/knight/knight.glb',
			'assets/generated/model/knight/sheet.png',
			'assets/generated/model/crate/crate.glb',
			'assets/generated/model/crate/sheet.png',
			'assets/generated/model/knight/knight.glb'
		]);
		expect(h.steps[CREATE].output).toContain('2 of 2 model(s) done.');
		expect(h.steps[ANIMATE].output).toContain('1 of 1 animated model(s) done.');
		expect(h.steps[REPORT].output).toContain('| Knight | done | 1.8 m |');
		expect(h.steps[REPORT].output).toContain('Report: assets/REPORT-models.md');
		expect(files.get('assets/REPORT-models.md')).toContain('# 3D models report');
		// Attended by default: one review question per model.
		expect(question.ask.mock.calls.map(([q]) => q.question)).toEqual([
			'Knight: keep this model?',
			'Crate: keep this model?'
		]);
		for (const idx of [CREATE, ANIMATE, REPORT]) expect(h.steps[idx].status).toBe('succeeded');
	});

	it('fails with the report written when no model built', async () => {
		files.set(SPEC_PATH, renderModelSpec(knightSpec()));
		verdict.judgeModel.mockResolvedValue({
			done: false,
			problems: ['build() exported nothing.'],
			warnings: [],
			text: '',
			sheetPng: null,
			clipSheets: {},
			glb: null
		});
		const h = harness({ config: { run_mode: 'unattended', rounds: 1 } });

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('failed');
		expect(h.finished?.error).toMatch(/^No model built\./);
		expect(h.steps[REPORT].status).toBe('failed');
		expect(h.steps[ANIMATE].output).toBe('Skipped — no built model has clips.');
		expect(files.get('assets/REPORT-models.md')).toContain('needs work');
	});

	it('never stops for a review when unattended', async () => {
		files.set(SPEC_PATH, renderModelSpec(knightSpec()));
		const h = harness({ config: { run_mode: 'unattended' } });

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('succeeded');
		expect(question.ask).not.toHaveBeenCalled();
	});

	it('cancels the run when the review is dismissed', async () => {
		files.set(SPEC_PATH, renderModelSpec(knightSpec()));
		question.ask.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
		const h = harness();

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished).toEqual({ status: 'cancelled', error: null });
		expect(h.steps[CREATE].status).toBe('cancelled');
	});

	it('reads the spec from the job’s own path', async () => {
		files.set('plan/arena/models.json', renderModelSpec(knightSpec()));
		const h = harness({ config: { spec_path: 'plan/arena/models.json' } });

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('succeeded');
		expect(h.steps[SPEC].output).toMatch(/^plan\/arena\/models\.json — /);
	});

	it('fails on a spec with problems, lists them, and never overwrites it', async () => {
		const bad = knightSpec();
		bad.entries[0].height_m = 900;
		const json = renderModelSpec(bad);
		files.set(SPEC_PATH, json);
		const h = harness({ config: { description: 'a knight' } });

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('failed');
		expect(h.finished?.error).toContain(`The spec at ${SPEC_PATH} has problems`);
		expect(h.finished?.error).toContain('knight: height_m');
		expect(h.steps[SPEC].status).toBe('failed');
		expect(files.get(SPEC_PATH)).toBe(json);
		expect(h.turns).toEqual([]);
	});

	it('fails on a file that is not a spec', async () => {
		files.set(SPEC_PATH, '{ not json');
		const h = harness();

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished?.error).toContain('could not be read');
		expect(files.get(SPEC_PATH)).toBe('{ not json');
	});
});

describe('a run with no spec', () => {
	it('fails without a description', async () => {
		const h = harness();

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished).toEqual({ status: 'failed', error: 'No models.json and no description.' });
	});

	it('writes one from the description on the job’s own model', async () => {
		const h = harness({
			config: { description: 'a knight and a crate' },
			turn: () => submit(SUBMITTED)
		});

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('succeeded');
		expect(deriveTurns(h)).toHaveLength(1);
		const [turn] = deriveTurns(h);
		expect(turn.turnKind).toBe('models.derive');
		expect(turn.forceFinalTool).toBe(SUBMIT_MODEL_SPEC_TOOL);
		expect(turn.toolAllowlist).toContain(SUBMIT_MODEL_SPEC_TOOL);
		expect(turn.toolAllowlist).not.toContain('fs_write_text');
		// The spec stage stays on the job's model.
		expect(turn.model).toBeUndefined();
		expect(turn.systemPrompt).toContain('a knight and a crate');

		expect(written).toEqual([SPEC_PATH, 'assets/REPORT-models.md']);
		const parsed = parseModelSpec(files.get(SPEC_PATH)!);
		if ('errors' in parsed) throw new Error(parsed.errors.join('; '));
		expect(parsed.spec).toEqual(knightSpec());
		expect(h.steps[SPEC].output).toContain(`Wrote ${SPEC_PATH} — 2 model(s), 1 animated (Walk)`);
	});

	it('gives each entry a unique id the runner chose', async () => {
		const h = harness({
			config: { description: 'two crates' },
			turn: () =>
				submit({
					style: 's',
					entries: [
						{ title: 'Crate', description: 'one', height_m: 0.6 },
						{ title: 'Crate', description: 'two', height_m: 0.8 }
					]
				})
		});

		await runModelGenerationPipeline(h.ctx);

		const parsed = parseModelSpec(files.get(SPEC_PATH)!);
		if ('errors' in parsed) throw new Error(parsed.errors.join('; '));
		expect(parsed.spec.entries.map((e) => [e.id, e.dir])).toEqual([
			['crate', 'assets/generated/model/crate/'],
			['crate_2', 'assets/generated/model/crate_2/']
		]);
	});

	it('retries once with the problems quoted, then writes the corrected spec', async () => {
		let n = 0;
		const h = harness({
			config: { description: 'a knight and a crate' },
			turn: () => {
				n++;
				if (n === 1) {
					return submit({
						...SUBMITTED,
						entries: [{ ...SUBMITTED.entries[0], parts: [] }, SUBMITTED.entries[1]]
					});
				}
				return submit(SUBMITTED);
			}
		});

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('succeeded');
		expect(deriveTurns(h)).toHaveLength(2);
		expect(deriveTurns(h)[1].userMessage).toContain(
			'knight: has clips but no parts for them to move.'
		);
		expect(written).toEqual([SPEC_PATH, 'assets/REPORT-models.md']);
	});

	it('fails after two unusable submissions and writes nothing', async () => {
		const h = harness({
			config: { description: 'a knight' },
			turn: () => null
		});

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('failed');
		expect(h.finished?.error).toContain('Could not write a usable models spec after 2 attempts');
		expect(h.turns).toHaveLength(2);
		expect(written).toEqual([]);
	});
});

describe('the handoff', () => {
	const unbuilt = {
		done: false,
		problems: ['build() exported nothing.'],
		warnings: [],
		text: '',
		sheetPng: null,
		clipSheets: {},
		glb: null
	};

	it('chains nothing for a standalone job, and says so', async () => {
		files.set(SPEC_PATH, renderModelSpec(knightSpec()));
		const h = harness({ config: { run_mode: 'unattended' } });

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('succeeded');
		expect(h.steps[HANDOFF]).toMatchObject({ status: 'succeeded' });
		expect(h.steps[HANDOFF].output).toContain('no coding configuration');
		expect(jobs.createJob).not.toHaveBeenCalled();
	});

	it('starts the coding job with the models spec and what is missing', async () => {
		files.set(SPEC_PATH, renderModelSpec(knightSpec()));
		// The knight builds; the crate never does.
		verdict.judgeModel.mockImplementation(async (...args: unknown[]) =>
			JSON.stringify(args).includes('crate')
				? unbuilt
				: {
						done: true,
						problems: [],
						warnings: [],
						text: '',
						sheetPng: 'data:image/png;base64,iVBORw0KGgo=',
						clipSheets: {},
						glb: new Uint8Array([1])
					}
		);
		jobs.createJob.mockResolvedValue(500);
		const h = harness({
			config: {
				run_mode: 'unattended',
				rounds: 1,
				coding_run: { plan_dir: 'plan/x/', asset_spec_path: 'plan/x/assets.json' },
				chain_base_name: 'Arena',
				chain_coding_model: { model_remote_model_id: 'coder' }
			}
		});
		(h.ctx as { trigger: string }).trigger = 'chained';
		h.ctx.startChainedRun = async () => 501;

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('succeeded');
		const input = jobs.createJob.mock.calls[0][0];
		expect(input.name).toBe('Arena — coding');
		expect(input.job_type).toBe('autonomous_coding');
		expect(input.model_remote_model_id).toBe('coder');
		const cfg = JSON.parse(input.type_config);
		// The 2D run's spec stays beside the 3D one.
		expect(cfg).toMatchObject({
			plan_dir: 'plan/x/',
			asset_spec_path: 'plan/x/assets.json',
			models_spec_path: SPEC_PATH,
			missing_models: ['crate']
		});
		expect(h.steps[HANDOFF].output).toContain('Started coding job 500 (run 501)');
		expect(h.steps[HANDOFF].output).toContain('NOT on disk: crate');
	});
});

describe('cancel', () => {
	it('stops before the model is asked', async () => {
		const h = harness({ config: { description: 'a knight' }, turn: () => submit(SUBMITTED) });
		h.ctx.abort.abort();

		await runModelGenerationPipeline(h.ctx);

		expect(h.finished).toEqual({ status: 'cancelled', error: null });
		expect(h.steps[SPEC].status).toBe('cancelled');
		expect(h.turns).toEqual([]);
	});
});
