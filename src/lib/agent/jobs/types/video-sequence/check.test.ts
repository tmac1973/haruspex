import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { invoke } from '@tauri-apps/api/core';
import { checkTimes, clipChecker, flaggedClips, flaggedSummary, withFollowers } from './check';
import { SUBMIT_CLIP_CHECK_TOOL } from './tools';
import { configDefaults } from './config';
import { planClips } from '#lib/sequence/spec/plan.ts';
import { LTX_MODEL, foxSpec } from '#lib/testing/sequenceSpecs.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { RunFiles } from './files';

const files = { path: (rel: string) => `ep1/${rel}` } as RunFiles;

function ctxWith(vision: boolean, verdict: unknown) {
	const turns: Parameters<JobRunContext['runJobTurn']>[0][] = [];
	const ctx = {
		job: { working_dir: '/v' },
		visionSupported: () => vision,
		contextSize: () => 32768,
		runJobTurn: async (opts: Parameters<JobRunContext['runJobTurn']>[0]) => {
			turns.push(opts);
			opts.onToolStart?.({ id: 'c', name: SUBMIT_CLIP_CHECK_TOOL, arguments: verdict as never });
			return { finalText: '', rawText: '' };
		}
	} as unknown as JobRunContext;
	return { ctx, turns };
}

describe('clip checks', () => {
	it('look at the first, middle and last frames', () => {
		const [a, b, c] = checkTimes(121, 24);
		expect(a).toBe(0);
		expect(b).toBeCloseTo(121 / 48);
		expect(c).toBeCloseTo(119 / 24);
	});

	it('are off without a model that can see, or with checks off', () => {
		const cfg = { ...configDefaults(), episode_dir: 'ep1' };
		expect(clipChecker(ctxWith(false, null).ctx, cfg, files, 24)).toBeUndefined();
		expect(
			clipChecker(ctxWith(true, null).ctx, { ...cfg, vision_checks: false }, files, 24)
		).toBeUndefined();
	});

	it('put the start picture and keyframe on the sheet, and ask two questions', async () => {
		vi.mocked(invoke).mockImplementation(async (cmd, args) => {
			if (cmd !== 'video_frames') return null;
			const req = (args as { request: { images: unknown[]; path: string } }).request;
			expect(req.path).toBe('ep1/generated/snow-02.webm');
			expect(req.images).toEqual([
				{ path: 'ep1/.haruspex/stills/snow-01-last.png', label: 'start' },
				{ path: 'ep1/keyframes/snow.png', label: 'keyframe' }
			]);
			return {
				dataUrl: 'data:image/jpeg;base64,AA',
				tiles: [{ n: 1, label: 'start' }, { n: 2, label: 'keyframe' }, { n: 3 }, { n: 4 }, { n: 5 }]
			};
		});
		const { ctx, turns } = ctxWith(true, { ok: false, problem: 'the fox turned grey' });
		const check = clipChecker(ctx, { ...configDefaults(), episode_dir: 'ep1' }, files, 24)!;
		const item = planClips(foxSpec(), LTX_MODEL, true).items[1];
		const verdict = await check(item as never, 'generated/snow-02.webm', {
			start: '.haruspex/stills/snow-01-last.png',
			keyframe: 'keyframes/snow.png'
		});
		expect(verdict).toEqual({ ok: false, problem: 'the fox turned grey' });
		expect(turns[0].forceFinalTool).toBe(SUBMIT_CLIP_CHECK_TOOL);
		expect(turns[0].userMessage).toContain('1. Does tile 3 continue tile 1');
		expect(turns[0].userMessage).toContain("2. Do tiles 4 and 5 still show tile 2's subject");
		expect(turns[0].history?.[0].content).toEqual([
			{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA' } }
		]);
	});

	it('list what still failed, and what must be made again with it', () => {
		const plan = planClips(foxSpec(), LTX_MODEL, true);
		const clips = {
			'snow-11': { key: 'k', status: 'done' as const, check: { ok: false, problem: 'a jump' } },
			'snow-03': { key: 'k', status: 'done' as const, check: { ok: true } }
		};
		const flagged = flaggedClips(plan, clips);
		expect(flagged).toEqual([{ id: 'snow-11', problem: 'a jump' }]);
		expect(flaggedSummary(flagged)).toBe(
			'1 clip failed the check twice and was kept:\n- snow-11: a jump'
		);
		// snow-11 and what continues from it: snow-12 and the transition out of snow.
		expect(withFollowers(plan, ['snow-11'])).toEqual(['snow-11', 'snow-12', 'join-1']);
		expect(flaggedSummary([])).toBe('Every clip passed its check.');
	});
});
