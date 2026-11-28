/**
 * The Check stage on its own: which clips are flagged (`check.ts`), the
 * Generate stage and the user's answer are stand-ins, so these check what the
 * stage does with them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { StepMarkers } from '#lib/agent/jobs/stepMarkers.ts';
import type { RunFiles } from '#lib/agent/jobs/types/video-sequence/files.ts';
import type { GenerateStageRun } from '#lib/agent/jobs/types/video-sequence/generateStage.ts';
import type { UserAnswer } from '#lib/stores/userQuestion.svelte.ts';
import {
	configDefaults,
	type VideoSequenceConfig
} from '#lib/agent/jobs/types/video-sequence/config.ts';
import { CHECK } from '#lib/agent/jobs/types/video-sequence/stages.ts';

const m = vi.hoisted(() => ({
	/** What `flaggedClips` answers, call by call. */
	flagged: [] as { id: string }[][],
	answer: null as UserAnswer | null,
	asked: 0,
	progress: { clips: {} as Record<string, unknown> },
	written: [] as unknown[],
	generate: vi.fn(async () => {})
}));
vi.mock('#lib/agent/jobs/types/video-sequence/check.ts', () => ({
	flaggedClips: () => m.flagged.shift() ?? [],
	flaggedSummary: (f: { id: string }[]) => `${f.length} flagged`,
	withFollowers: (_plan: unknown, ids: string[]) => [...ids, `${ids[0]}-next`]
}));
vi.mock('#lib/agent/jobs/types/video-sequence/generateStage.ts', () => ({
	generateStage: m.generate
}));
vi.mock('#lib/stores/userQuestion.svelte.ts', () => ({
	askUserQuestion: async () => {
		m.asked++;
		if (!m.answer) throw new Error('no answer set');
		return m.answer;
	}
}));
vi.mock('#lib/agent/jobs/types/video-sequence/files.ts', () => ({
	readProgress: async () => structuredClone(m.progress),
	writeProgress: async (_files: unknown, p: unknown) => {
		m.written.push(p);
	}
}));
vi.mock('#lib/sequence/spec/progress.ts', () => ({
	mergeProgress: (p: { clips: Record<string, unknown> }) => p
}));

import { checkStage } from './checkStage.ts';

const selected = (label: string): UserAnswer =>
	({ kind: 'selected', labels: [label] }) as UserAnswer;

function steps() {
	return { start: vi.fn(), succeed: vi.fn() };
}

function ctx(vision = true): JobRunContext {
	return {
		runId: 3,
		abort: new AbortController(),
		visionSupported: () => vision
	} as unknown as JobRunContext;
}

const cfg = (checks = true): VideoSequenceConfig => ({
	...configDefaults(),
	vision_checks: checks
});
const run = (attended: boolean) =>
	({ spec: {}, plan: { items: [] }, attended }) as unknown as GenerateStageRun;
const files = {} as RunFiles;

async function check(opts: { attended?: boolean; vision?: boolean; checks?: boolean } = {}) {
	const s = steps();
	await checkStage(
		ctx(opts.vision ?? true),
		s as unknown as StepMarkers,
		cfg(opts.checks ?? true),
		files,
		run(opts.attended ?? true)
	);
	return s;
}

beforeEach(() => {
	m.flagged = [[{ id: 's1-c2' }]];
	m.answer = null;
	m.asked = 0;
	m.progress = { clips: { 's1-c1': 'ok', 's1-c2': 'flagged', 's1-c2-next': 'ok' } };
	m.written = [];
	m.generate.mockClear();
});

describe('checkStage', () => {
	it('skips when checks are off', async () => {
		const s = await check({ checks: false });
		expect(s.succeed).toHaveBeenCalledWith(CHECK, 'Skipped: checks are off.');
	});

	it('skips when the job’s model can’t see', async () => {
		const s = await check({ vision: false });
		expect(s.succeed).toHaveBeenCalledWith(CHECK, "Skipped: the job's model can't see pictures.");
	});

	it('reports the flagged clips without asking in an unattended run', async () => {
		const s = await check({ attended: false });
		expect(m.asked).toBe(0);
		expect(s.succeed).toHaveBeenCalledWith(CHECK, '1 flagged');
	});

	it('asks nothing when no clip was flagged', async () => {
		m.flagged = [[]];
		const s = await check();
		expect(m.asked).toBe(0);
		expect(s.succeed).toHaveBeenCalledWith(CHECK, '0 flagged');
	});

	it('keeps the clips as they are on Keep going, or on a typed answer', async () => {
		m.answer = selected('Keep going');
		await check();
		m.flagged = [[{ id: 's1-c2' }]];
		m.answer = { kind: 'freeText', text: 'not sure' };
		const s = await check();
		expect(m.asked).toBe(2);
		expect(m.generate).not.toHaveBeenCalled();
		expect(s.succeed).toHaveBeenCalledWith(CHECK, '1 flagged');
	});

	it('ends the run on Stop', async () => {
		m.answer = selected('Stop');
		await expect(check()).rejects.toMatchObject({ name: 'AbortError' });
		expect(m.generate).not.toHaveBeenCalled();
	});

	it('remakes the flagged clips and their followers on Redo flagged, then checks again', async () => {
		m.answer = selected('Redo flagged');
		m.flagged = [[{ id: 's1-c2' }], []];
		const s = await check();
		// The flagged clip and the one continuing from it are forgotten; the rest stay.
		expect(m.written).toEqual([{ clips: { 's1-c1': 'ok' } }]);
		expect(m.generate).toHaveBeenCalledTimes(1);
		const [, , , , redoRun] = m.generate.mock.calls[0] as unknown as [
			unknown,
			unknown,
			unknown,
			unknown,
			GenerateStageRun
		];
		// Made again without asking: the user just chose to.
		expect(redoRun.attended).toBe(false);
		expect(s.start).toHaveBeenCalledTimes(2);
		expect(s.succeed).toHaveBeenCalledWith(CHECK, '0 flagged');
	});
});
