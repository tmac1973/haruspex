/**
 * The attended review: questions per model, rebuilds from notes.
 *
 * Stand-ins at the module boundaries: the question modal, Tauri's `invoke`,
 * `judgeModel`, and the runner's context, whose `runJobTurn` is the model.
 */

import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { ModelVerdict } from '#lib/models3d/verdict.ts';
import type { ModelSpec } from '#lib/models3d/spec/types.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import type { RunTrigger } from '#lib/agent/jobs/runner.svelte.ts';
import type { EphemeralTurnResult } from '#lib/agent/runEphemeralTurn.ts';
import type { UserAnswer, UserQuestionRequest } from '#lib/stores/userQuestion.svelte.ts';
import { parseModelGenerationConfig } from './config';
import { isAttended, reviewStage } from './review';
import { initialEntryStates, type EntryState } from './state';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
const verdict = vi.hoisted(() => ({ judgeModel: vi.fn() }));
vi.mock('#lib/models3d/verdict.ts', () => ({ judgeModel: verdict.judgeModel }));
const question = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock('#lib/stores/userQuestion.svelte.ts', () => ({ askUserQuestion: question.ask }));

const SHEET = 'data:image/png;base64,iVBORw0KGgo=';

const keep: UserAnswer = { kind: 'selected', labels: ['Keep'] };
const skip: UserAnswer = { kind: 'selected', labels: ['Skip it'] };
const note = (text: string): UserAnswer => ({ kind: 'freeText', text });

function spec(): ModelSpec {
	const entry = (id: string, title: string) => ({
		id,
		title,
		description: `A ${id}.`,
		height_m: 1,
		parts: [],
		clips: [],
		dir: `assets/generated/model/${id}/`
	});
	return { version: 1, style: '', entries: [entry('knight', 'Knight'), entry('crate', 'Crate')] };
}

function built(s: ModelSpec): EntryState[] {
	return initialEntryStates(s).map((st) => ({ ...st, status: 'done', rounds: 1, sheet: SHEET }));
}

type TurnOpts = Parameters<JobRunContext['runJobTurn']>[0];

function harness(trigger: RunTrigger = 'manual', config: Record<string, unknown> = {}) {
	const turns: TurnOpts[] = [];
	const ctx = {
		job: { id: 1, working_dir: '/proj', type_config: '{}', steps: [] } as unknown as JobWithSteps,
		runId: 5,
		abort: new AbortController(),
		trigger,
		runJobTurn: async (opts: TurnOpts) => {
			turns.push(opts);
			return {} as EphemeralTurnResult;
		},
		patchStep: () => {},
		buildStreamCallbacks: () => ({}),
		isLive: () => true,
		describeModel: () => ({ label: 'Settings default', vision: true, contextSize: 32768 })
	} as unknown as JobRunContext;
	const cfg = parseModelGenerationConfig(JSON.stringify(config));
	const s = spec();
	const states = built(s);
	return { ctx, cfg, spec: s, states, turns, run: () => reviewStage(ctx, cfg, s, states, 1) };
}

const asked = () =>
	question.ask.mock.calls.map(([q]) => (q as UserQuestionRequest).question.split(':')[0]);

beforeEach(() => {
	vi.clearAllMocks();
	// Every build module exists, so a rebuild is judged.
	vi.mocked(invoke).mockImplementation(invokeRouter({ fs_read_bytes: [1], fs_write_bytes: null }));
	verdict.judgeModel.mockResolvedValue({
		done: true,
		problems: [],
		warnings: [],
		text: '',
		sheetPng: SHEET,
		clipSheets: {},
		glb: new Uint8Array([1])
	} satisfies ModelVerdict);
});

describe('reviewStage', () => {
	it('keeps every model without a rebuild', async () => {
		question.ask.mockResolvedValue(keep);
		const h = harness();

		await h.run();

		expect(asked()).toEqual(['Knight', 'Crate']);
		expect(h.turns).toEqual([]);
		expect(h.states.map((s) => s.status)).toEqual(['done', 'done']);
		const [q] = question.ask.mock.calls[0] as [UserQuestionRequest, AbortSignal];
		expect(q.imageUrl).toBe(SHEET);
		expect(q.options.map((o) => o.label)).toEqual(['Keep', 'Skip it']);
		expect(q.body).toBeUndefined();
	});

	it('rebuilds a noted model with the note, then asks about it again', async () => {
		question.ask
			.mockResolvedValueOnce(note('Make the helmet taller.'))
			.mockResolvedValueOnce(keep)
			.mockResolvedValueOnce(keep);
		const h = harness();

		await h.run();

		// Both asked first; only the rebuilt one asked again.
		expect(asked()).toEqual(['Knight', 'Crate', 'Knight']);
		expect(h.turns).toHaveLength(1);
		expect(h.turns[0].userMessage).toContain('Make the helmet taller.');
		expect(h.turns[0].userMessage).toContain('A knight.');
		expect(h.turns[0].writeRoot).toBe('assets/generated/model/knight/');
		expect(h.states[0]).toMatchObject({ status: 'done', note: 'Make the helmet taller.' });
	});

	it('rebuilds again on a second note', async () => {
		question.ask
			.mockResolvedValueOnce(note('Taller.'))
			.mockResolvedValueOnce(keep)
			.mockResolvedValueOnce(note('Now red.'))
			.mockResolvedValueOnce(keep);
		const h = harness();

		await h.run();

		expect(asked()).toEqual(['Knight', 'Crate', 'Knight', 'Knight']);
		expect(h.turns.map((t) => t.userMessage.split('\n')[0])).toEqual([
			'The user reviewed this model and asked for a change: Taller.',
			'The user reviewed this model and asked for a change: Now red.'
		]);
	});

	it('marks a skipped model skipped and never rebuilds it', async () => {
		question.ask.mockResolvedValueOnce(skip).mockResolvedValueOnce(keep);
		const h = harness();

		await h.run();

		expect(h.states.map((s) => s.status)).toEqual(['skipped', 'done']);
		expect(h.turns).toEqual([]);
	});

	it('lists a needs-work model’s open problems, and asks with no image when nothing built', async () => {
		question.ask.mockResolvedValue(keep);
		const h = harness();
		h.states[0] = {
			...h.states[0],
			status: 'needs_work',
			problems: ['No knight.js was written.'],
			sheet: null
		};

		await h.run();

		const [q] = question.ask.mock.calls[0] as [UserQuestionRequest, AbortSignal];
		expect(q.body).toBe('Open problems:\n\n- No knight.js was written.');
		expect(q.imageUrl).toBeUndefined();
	});

	it('ends the run on a dismissed question', async () => {
		question.ask.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
		const h = harness();

		await expect(h.run()).rejects.toThrow('Aborted');
		expect(h.turns).toEqual([]);
	});
});

describe('isAttended', () => {
	it('is true for an attended run a person started', () => {
		const h = harness('manual');
		expect(isAttended(h.ctx, h.cfg)).toBe(true);
	});

	it('never stops a chained run', () => {
		const h = harness('chained');
		expect(isAttended(h.ctx, h.cfg)).toBe(false);
	});

	it('never stops an unattended run', () => {
		const h = harness('manual', { run_mode: 'unattended' });
		expect(isAttended(h.ctx, h.cfg)).toBe(false);
	});
});
