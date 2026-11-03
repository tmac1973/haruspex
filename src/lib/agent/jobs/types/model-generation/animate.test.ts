/**
 * The animation stage's loop: turns on the animation model, judged in code,
 * with the build module guarded.
 *
 * Stand-ins at the module boundaries: Tauri's `invoke` (an in-memory working
 * directory of bytes), `judgeModel`, and the runner's context, whose
 * `runJobTurn` is the model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { ModelVerdict } from '#lib/glb/verdict.ts';
import type { ModelSpec } from '#lib/models3d/spec/types.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import type { RunStepState } from '#lib/agent/jobs/runner.svelte.ts';
import type { EphemeralTurnResult } from '#lib/agent/runEphemeralTurn.ts';
import type { ModelColumns } from '#lib/agent/jobs/chainModel.ts';
import { parseModelGenerationConfig } from './config';
import { animateStage, clipsSummary } from './animate';
import { initialEntryStates, type EntryState } from './state';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
const verdict = vi.hoisted(() => ({ judgeModel: vi.fn() }));
vi.mock('#lib/glb/verdict.ts', () => ({ judgeModel: verdict.judgeModel }));

const DIR = 'assets/generated/model/knight/';
const BUILD = `${DIR}knight.js`;
const ANIM = `${DIR}knight.anim.js`;
const GLB = `${DIR}knight.glb`;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SOURCE = [
	...new TextEncoder().encode('export default (THREE) => new THREE.Group(); // Hip_L')
];

let files: Map<string, number[]>;

function spec(): ModelSpec {
	return {
		version: 1,
		style: '',
		entries: [
			{
				id: 'knight',
				title: 'Knight',
				description: 'An armoured knight.',
				height_m: 1.8,
				parts: ['Hip_L', 'Hip_R'],
				clips: [{ name: 'Walk', seconds: 1, loop: true, action: 'walks forward' }],
				dir: DIR
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

const pass = (): ModelVerdict => ({
	done: true,
	problems: [],
	warnings: [],
	text: '',
	sheetPng: PNG,
	clipSheets: { Walk: PNG },
	glb: new Uint8Array([7])
});

const fail = (problems: string[]): ModelVerdict => ({
	...pass(),
	done: false,
	problems,
	clipSheets: {},
	glb: null
});

const ARGON: ModelColumns = {
	model_remote_base_url: 'https://argon.example/v1',
	model_remote_api_key: null,
	model_remote_api_key_id: null,
	model_remote_model_id: 'argon-4',
	model_remote_context_size: 200000,
	model_remote_vision_supported: true,
	model_advanced: null
};

type TurnOpts = Parameters<JobRunContext['runJobTurn']>[0];

function harness(
	config: Record<string, unknown> = {},
	// Each turn's module differs, as a model's edits do: an unchanged one is the same attempt.
	turn: (n: number) => void = (n) => files.set(ANIM, [n])
) {
	const turns: TurnOpts[] = [];
	const step: Partial<RunStepState> = {};
	const ctx = {
		job: { id: 1, working_dir: '/proj', type_config: '{}', steps: [] } as unknown as JobWithSteps,
		runId: 5,
		abort: new AbortController(),
		trigger: 'manual',
		runJobTurn: async (opts: TurnOpts) => {
			turns.push(opts);
			turn(turns.length);
			return {} as EphemeralTurnResult;
		},
		patchStep: (_i: number, patch: Partial<RunStepState>) => Object.assign(step, patch),
		buildStreamCallbacks: () => ({}),
		isLive: () => true,
		describeModel: (cols: ModelColumns) => ({
			label: cols.model_remote_model_id ?? 'Settings default',
			vision: false,
			contextSize: 32768
		})
	} as unknown as JobRunContext;
	const cfg = parseModelGenerationConfig(JSON.stringify(config));
	const s = spec();
	const states: EntryState[] = initialEntryStates(s).map((st) => ({
		...st,
		status: 'done',
		glb: true
	}));
	return {
		ctx,
		cfg,
		spec: s,
		states,
		turns,
		step,
		run: () => animateStage(ctx, cfg, s, states, 2)
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	files = new Map([
		[BUILD, [...SOURCE]],
		[GLB, [1]]
	]);
	tauri.invoke.mockImplementation(
		invokeRouter({
			fs_read_bytes: (a) => {
				const v = files.get(a!.relPath as string);
				if (v === undefined) throw `Not a file: ${String(a!.relPath)}`;
				return v;
			},
			fs_write_bytes: (a) => {
				files.set(a!.relPath as string, a!.bytes as number[]);
			}
		})
	);
});

describe('animateStage', () => {
	it('animates only entries with clips, on the animation model, and writes the clips', async () => {
		verdict.judgeModel.mockResolvedValue(pass());
		const h = harness({ animate_model: ARGON, animate_turns: 30 });

		await h.run();

		expect(h.turns).toHaveLength(1);
		const [turn] = h.turns;
		expect(turn.model).toEqual(ARGON);
		expect(turn.turnKind).toBe('models.animate');
		expect(turn.maxIterations).toBe(30);
		expect(turn.writeRoot).toBe(DIR);
		expect(turn.toolAllowlist).not.toContain('draw_texture');
		// The build module is in the message, so the hierarchy is in view.
		expect(turn.userMessage).toContain('// Hip_L');
		expect(turn.userMessage).toContain('- Walk: 1 s, loops. walks forward');
		expect(verdict.judgeModel.mock.calls[0][0]).toMatchObject({ stage: 'animate' });

		expect(files.get(GLB)).toEqual([7]);
		expect(files.has(`${DIR}clip-walk.png`)).toBe(true);
		expect(h.states[0].clips).toMatchObject({ status: 'done', rounds: 1, sheets: ['Walk'] });
		expect(h.states[1].clips).toBeNull();
		expect(h.step.description).toBe('Animate the models with clips · argon-4');
		expect(h.step.checklist).toEqual([{ label: 'Knight', status: 'done' }]);
		expect(clipsSummary(h.spec, h.states)).toContain('1 of 1 animated model(s) done.');
	});

	it('ends a turn once its clips pass, and only then', async () => {
		verdict.judgeModel.mockResolvedValue(pass());
		const h = harness();
		await h.run();
		const end = h.turns[0].endTurnWhen!;
		const check = [{ name: 'check_3d' }] as never;

		// A batch with no check doesn't judge.
		verdict.judgeModel.mockClear();
		expect(await end([{ name: 'fs_write_text' }] as never)).toBe(false);
		expect(verdict.judgeModel).not.toHaveBeenCalled();

		files.set(ANIM, [10]);
		expect(await end(check)).toBe(true);
		expect(verdict.judgeModel.mock.calls[0][0]).toMatchObject({ stage: 'animate' });

		// An unchanged module is the same attempt: judged once.
		verdict.judgeModel.mockClear();
		expect(await end(check)).toBe(true);
		expect(verdict.judgeModel).not.toHaveBeenCalled();

		files.set(ANIM, [20]);
		verdict.judgeModel.mockResolvedValue(fail(['Walk: the loop does not close.']));
		expect(await end(check)).toBe(false);

		files.set(ANIM, [21]);
		verdict.judgeModel.mockResolvedValue(pass());
		files.set(BUILD, [0]);
		expect(await end(check)).toBe(false);
		files.set(BUILD, [...SOURCE]);

		files.set(ANIM, [22]);
		verdict.judgeModel.mockRejectedValue(new Error('no WebGL'));
		expect(await end(check)).toBe(false);
	});

	it('puts a changed build module back and says so', async () => {
		verdict.judgeModel.mockResolvedValueOnce(fail(['Walk: the loop does not close.']));
		verdict.judgeModel.mockResolvedValue(pass());
		const h = harness({}, (n) => {
			files.set(ANIM, [n]);
			if (n === 1) files.set(BUILD, [0]);
		});

		await h.run();

		expect(files.get(BUILD)).toEqual(SOURCE);
		expect(h.turns).toHaveLength(2);
		expect(h.turns[1].userMessage).toContain(
			'knight.js was changed; it was put back. Change only knight.anim.js.'
		);
		expect(h.states[0].clips?.status).toBe('done');
	});

	it('passes a round whose clips pass once the build module is put back', async () => {
		verdict.judgeModel.mockResolvedValue(pass());
		const h = harness({}, (n) => {
			files.set(ANIM, [n]);
			files.set(BUILD, [0]);
		});

		await h.run();

		expect(files.get(BUILD)).toEqual(SOURCE);
		expect(h.turns).toHaveLength(1);
		expect(h.states[0].clips?.status).toBe('done');
	});

	it('keeps every attempt and puts the best one forward', async () => {
		verdict.judgeModel
			.mockResolvedValueOnce(fail(['Walk: the loop does not close.']))
			.mockResolvedValueOnce({ ...fail(['Walk: a', 'Walk: b', 'Walk: c']), glb: null });
		const h = harness({ rounds: 2 });

		await h.run();

		// Round 1 had one problem, round 2 three and no GLB: round 1 stays.
		expect(files.get(ANIM)).toEqual([1]);
		expect(files.get(`${DIR}attempts/animate-01/knight.anim.js`)).toEqual([1]);
		expect(files.get(`${DIR}attempts/animate-02/knight.anim.js`)).toEqual([2]);
		const notes = new TextDecoder().decode(
			new Uint8Array(files.get(`${DIR}attempts/animate-02/problems.txt`)!)
		);
		expect(notes).toContain('- Walk: c');
		expect(h.states[0].clips).toMatchObject({
			status: 'needs_work',
			attempts: 2,
			kept: 1,
			problems: ['Walk: the loop does not close.']
		});
	});

	it('repairs a missing clip in the next round', async () => {
		verdict.judgeModel
			.mockResolvedValueOnce(fail(['Missing clip "Walk".']))
			.mockResolvedValueOnce(pass());
		const h = harness();

		await h.run();

		expect(h.turns).toHaveLength(2);
		expect(h.turns[1].userMessage).toContain('- Missing clip "Walk".');
		expect(h.turns[1].userMessage).toContain('Fix knight.anim.js only');
	});

	it('marks needs work out of rounds and keeps the creation GLB', async () => {
		verdict.judgeModel.mockResolvedValue(fail(['Missing clip "Walk".']));
		const h = harness({ rounds: 2 });

		await h.run();

		expect(h.turns).toHaveLength(2);
		expect(files.get(GLB)).toEqual([1]);
		expect(h.states[0].status).toBe('needs_work');
		expect(h.states[0].clips).toMatchObject({
			status: 'needs_work',
			problems: ['Missing clip "Walk".']
		});
	});

	it('counts a turn that wrote no animation module as a round', async () => {
		const h = harness({ rounds: 1 }, () => {});

		await h.run();

		expect(verdict.judgeModel).not.toHaveBeenCalled();
		expect(h.states[0].clips?.problems).toEqual(['No knight.anim.js was written.']);
	});

	it('passes over skipped and unbuilt models', async () => {
		const skipped = harness();
		skipped.states[0].status = 'skipped';
		await skipped.run();
		expect(skipped.turns).toEqual([]);

		const unbuilt = harness();
		unbuilt.states[0] = { ...unbuilt.states[0], status: 'needs_work', glb: false };
		await unbuilt.run();
		expect(unbuilt.turns).toEqual([]);
		expect(clipsSummary(unbuilt.spec, unbuilt.states)).toBe('Skipped — no built model has clips.');
	});
});
