/**
 * The creation stage's loop: turns on the creation model, judged in code.
 *
 * Stand-ins at the module boundaries only: Tauri's `invoke` (an in-memory
 * working directory of bytes), `judgeModel` (the webview's checker), and the
 * runner's context, whose `runJobTurn` is the model.
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
import { createStage, createToolAllowlist } from './create';
import { initialEntryStates } from './state';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
const verdict = vi.hoisted(() => ({ judgeModel: vi.fn() }));
vi.mock('#lib/glb/verdict.ts', () => ({ judgeModel: verdict.judgeModel }));

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

let files: Map<string, number[]>;

function routes() {
	return invokeRouter({
		fs_read_bytes: (a) => {
			const v = files.get(a!.relPath as string);
			if (v === undefined) throw `Not a file: ${String(a!.relPath)}`;
			return v;
		},
		fs_write_bytes: (a) => {
			files.set(a!.relPath as string, a!.bytes as number[]);
		}
	});
}

function spec(): ModelSpec {
	return {
		version: 1,
		style: 'low-poly',
		entries: [
			{
				id: 'knight',
				title: 'Knight',
				description: 'An armoured knight.',
				height_m: 1.8,
				parts: ['Hip_L', 'Hip_R'],
				clips: [{ name: 'Walk', seconds: 1, loop: true, action: 'walks' }],
				dir: 'assets/generated/model/knight/'
			}
		]
	};
}

const pass = (): ModelVerdict => ({
	done: true,
	problems: [],
	warnings: [],
	text: 'ok',
	sheetPng: PNG,
	clipSheets: {},
	glb: new Uint8Array([1, 2, 3])
});

const fail = (problems: string[], glb = true): ModelVerdict => ({
	...pass(),
	done: false,
	problems,
	glb: glb ? new Uint8Array([9]) : null,
	sheetPng: glb ? PNG : null
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

function harness(config: Record<string, unknown> = {}, writes = true) {
	const turns: TurnOpts[] = [];
	const step: Partial<RunStepState> = {};
	const ctx = {
		job: { id: 1, working_dir: '/proj', type_config: '{}', steps: [] } as unknown as JobWithSteps,
		runId: 5,
		abort: new AbortController(),
		trigger: 'manual',
		runJobTurn: async (opts: TurnOpts) => {
			turns.push(opts);
			// The model writes its build module.
			if (writes) files.set('assets/generated/model/knight/knight.js', [1]);
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
	const states = initialEntryStates(s);
	return { ctx, cfg, spec: s, states, turns, step, run: () => createStage(ctx, cfg, s, states, 1) };
}

beforeEach(() => {
	vi.clearAllMocks();
	files = new Map();
	tauri.invoke.mockImplementation(routes());
});

describe('createStage', () => {
	it('is done after one clean round, and writes the GLB and the sheet', async () => {
		verdict.judgeModel.mockResolvedValue(pass());
		const h = harness();

		await h.run();

		expect(h.turns).toHaveLength(1);
		expect(h.states[0]).toMatchObject({ status: 'done', rounds: 1, problems: [], glb: true });
		expect(files.get('assets/generated/model/knight/knight.glb')).toEqual([1, 2, 3]);
		expect(files.has('assets/generated/model/knight/sheet.png')).toBe(true);
		expect(verdict.judgeModel.mock.calls[0][0]).toMatchObject({ stage: 'create' });
		expect(h.step.checklist).toEqual([{ label: 'Knight', status: 'done' }]);
		expect(h.step.description).toBe('Build every model · Settings default');
	});

	it('repairs on round 2 with the problems listed', async () => {
		verdict.judgeModel
			.mockResolvedValueOnce(fail(['Height is 2.4 m; the spec says 1.8 m (±10%).']))
			.mockResolvedValueOnce(pass());
		const h = harness();

		await h.run();

		expect(h.turns).toHaveLength(2);
		expect(h.turns[0].userMessage).toContain('Build: Knight');
		expect(h.turns[1].userMessage).toContain('- Height is 2.4 m; the spec says 1.8 m (±10%).');
		expect(h.turns[1].userMessage).toContain('Fix knight.js and check it again');
		expect(h.states[0].status).toBe('done');
	});

	it('marks needs work after the rounds run out, keeping the last good GLB', async () => {
		verdict.judgeModel
			.mockResolvedValueOnce(fail(['Missing part "Hip_L": name the pivot exactly so.']))
			.mockResolvedValueOnce(fail(['build() threw: x is not defined'], false));
		const h = harness({ rounds: 2 });

		await h.run();

		expect(h.turns).toHaveLength(2);
		expect(h.states[0]).toMatchObject({
			status: 'needs_work',
			rounds: 2,
			problems: ['build() threw: x is not defined'],
			glb: true
		});
		expect(files.get('assets/generated/model/knight/knight.glb')).toEqual([9]);
		expect(h.step.checklist).toEqual([
			{ label: 'Knight', status: 'blocked', detail: 'needs work' }
		]);
	});

	it('counts a turn that wrote no build module as a round', async () => {
		const h = harness({ rounds: 1 }, false);

		await h.run();

		expect(verdict.judgeModel).not.toHaveBeenCalled();
		expect(h.states[0]).toMatchObject({
			status: 'needs_work',
			problems: ['No knight.js was written.']
		});
	});

	it('runs on the creation model, confined to the entry’s folder', async () => {
		verdict.judgeModel.mockResolvedValue(pass());
		const h = harness({ create_model: ARGON, create_turns: 25 });

		await h.run();

		const [turn] = h.turns;
		expect(turn.model).toEqual(ARGON);
		expect(turn.writeRoot).toBe('assets/generated/model/knight/');
		expect(turn.maxIterations).toBe(25);
		expect(turn.turnKind).toBe('models.create');
		expect(h.step.description).toBe('Build every model · argon-4');
	});

	it('runs on the job’s model when there is no override', async () => {
		verdict.judgeModel.mockResolvedValue(pass());
		const h = harness();

		await h.run();

		expect(h.turns[0].model).toBeUndefined();
	});

	it('offers draw_texture only with Allow textures on', async () => {
		verdict.judgeModel.mockResolvedValue(pass());
		const off = harness();
		await off.run();
		expect(off.turns[0].toolAllowlist).not.toContain('draw_texture');
		expect(off.turns[0].systemPrompt).not.toContain('draw_texture');

		const on = harness({ allow_textures: true });
		await on.run();
		expect(on.turns[0].toolAllowlist).toContain('draw_texture');
		expect(on.turns[0].systemPrompt).toContain("kit.texture('textures/<name>.png')");
	});

	it('stops before a turn once cancelled', async () => {
		const h = harness();
		h.ctx.abort.abort();

		await expect(h.run()).rejects.toThrow('Aborted');
		expect(h.turns).toEqual([]);
	});
});

describe('createToolAllowlist', () => {
	it('is the file tools and check_3d', () => {
		expect(createToolAllowlist(false)).toEqual([
			'fs_read_text',
			'fs_list_dir',
			'fs_write_text',
			'fs_edit_text',
			'check_3d'
		]);
	});
});
