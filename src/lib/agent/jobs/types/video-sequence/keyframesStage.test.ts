/**
 * The Keyframes stage on its own: the image backend, the episode's files and
 * the user's answers are stand-ins; `makeKeyframes`, the progress file and
 * the step markers are real.
 */
import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { LTX_MODEL, foxSpec, presenterSpec } from '#lib/testing/sequenceSpecs.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import type { RunStepState } from '#lib/agent/jobs/runner.svelte.ts';
import type { UserAnswer, UserQuestionRequest } from '#lib/stores/userQuestion.svelte.ts';
import { stepMarkers } from '#lib/agent/jobs/stepMarkers.ts';
import { planClips } from '#lib/sequence/spec/plan.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';
import { KEYFRAMES } from '#lib/agent/jobs/types/video-sequence/stages.ts';
import { runFiles } from '#lib/agent/jobs/types/video-sequence/files.ts';
import {
	configDefaults,
	type VideoSequenceConfig
} from '#lib/agent/jobs/types/video-sequence/config.ts';
import { keyframesStage } from './keyframesStage.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
const image = vi.hoisted(() => ({
	kind: 'comfyui',
	canEdit: true,
	requests: [] as { prompt: string; edit?: unknown }[],
	/** Answers a request with a picture, or throws. */
	answer: null as null | ((n: number) => unknown)
}));
vi.mock('#lib/image/backend.ts', () => ({ resolveImageBackend: () => ({ kind: image.kind }) }));
vi.mock('#lib/image/route.ts', () => ({
	needOf: () => ({}),
	capableEntries: () => (image.canEdit ? [{}] : []),
	routedImageBackend: () => ({
		generate: async (req: { prompt: string; edit?: unknown }) => {
			image.requests.push(req);
			const custom = image.answer?.(image.requests.length);
			if (custom) return custom;
			return {
				images: [{ bytes: new Uint8Array([7]), mimeType: 'image/png', width: 1, height: 1 }],
				meta: {}
			};
		}
	})
}));
vi.mock('#lib/images/resolve.svelte.ts', () => ({
	registerLocalImage: (hash: string) => `haruspex-img://localhost/${hash}`
}));
const asked = vi.hoisted(() => ({
	questions: [] as UserQuestionRequest[],
	answers: [] as UserAnswer[]
}));
vi.mock('#lib/stores/userQuestion.svelte.ts', () => ({
	askUserQuestion: async (q: UserQuestionRequest) => {
		asked.questions.push(q);
		const a = asked.answers.shift();
		if (!a) throw new Error('no answer left for this question');
		return a;
	}
}));
vi.mock('#lib/stores/jobRuns.svelte.ts', () => ({
	markRunStepStarted: async () => {},
	markRunStepFinished: async () => {}
}));

let files: Map<string, string>;
let bytes: Map<string, Uint8Array>;

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
		fs_write_bytes: (a) => {
			bytes.set(a!.relPath as string, new Uint8Array(a!.bytes as number[]));
		},
		fs_read_bytes: (a) => {
			const v = bytes.get(a!.relPath as string);
			if (!v) throw 'missing';
			return Array.from(v);
		},
		fs_path_exists: (a) => bytes.has(a!.relPath as string) || files.has(a!.relPath as string),
		image_fit_cover: (a) => a!.bytes,
		image_store_bytes: () => 'f'.repeat(64),
		video_still_extract: (a) => {
			const req = a!.request as { out: string };
			bytes.set(req.out, new Uint8Array([2]));
			return { path: req.out, width: 1, height: 1, previewDataUrl: '' };
		}
	});
}

interface Harness {
	ctx: JobRunContext;
	steps: Array<Partial<RunStepState>>;
	cfg: VideoSequenceConfig;
}

function harness(): Harness {
	const steps: Array<Partial<RunStepState>> = Array.from({ length: 10 }, () => ({}));
	let current = 0;
	const ctx = {
		job: { id: 7, name: 'Fox', working_dir: '/videos', steps: [] } as unknown as JobWithSteps,
		runId: 9,
		abort: new AbortController(),
		trigger: 'manual',
		patchStep: (i: number, p: Partial<RunStepState>) => Object.assign(steps[i], p),
		setCurrentStepIndex: (i: number) => (current = i),
		liveStepIndex: () => current,
		stepAuthored: () => ''
	} as unknown as JobRunContext;
	return { ctx, steps, cfg: { ...configDefaults(), episode_dir: 'ep1' } };
}

/** Run the stage over `spec`, with the plan the run would make for it. */
function run(h: Harness, spec: SequenceSpec, opts: { draws?: boolean; attended?: boolean } = {}) {
	const draws = opts.draws ?? true;
	const plan = planClips(spec, LTX_MODEL, draws && image.kind !== 'none');
	return keyframesStage(h.ctx, stepMarkers(h.ctx), h.cfg, runFiles(h.ctx, h.cfg), {
		spec,
		plan,
		draws,
		attended: opts.attended ?? false
	});
}

const progress = () => JSON.parse(files.get('ep1/.haruspex/sequence-progress.json')!);

/** The fox spec with both sections opening on the user's own pictures. */
function ownPictures(): SequenceSpec {
	const spec = foxSpec();
	spec.sections = spec.sections.map((s) =>
		s.kind === 'generated' ? { ...s, start_image: `${s.id}.png` } : s
	);
	return spec;
}

beforeEach(() => {
	files = new Map();
	bytes = new Map();
	image.kind = 'comfyui';
	image.canEdit = true;
	image.requests = [];
	image.answer = null;
	asked.questions = [];
	asked.answers = [];
	vi.mocked(invoke).mockImplementation(routes());
});

describe('keyframesStage', () => {
	it('draws the first keyframe, edits the rest from it, and records them', async () => {
		const h = harness();
		const stills = await run(h, foxSpec());
		expect(stills.map((s) => [s.id, s.how])).toEqual([
			['snow', 'drawn'],
			['forest', 'edited'],
			['snow-r6', 'edited'],
			['snow-r12', 'edited'],
			['forest-r6', 'edited'],
			['forest-r12', 'edited']
		]);
		expect(image.requests[0].edit).toBeUndefined();
		expect(image.requests[1].prompt).toMatch(/^The same subject as in the picture, now: a fox/);
		expect(bytes.has('ep1/keyframes/snow.png')).toBe(true);
		expect(bytes.has('ep1/keyframes/forest-r12.png')).toBe(true);
		expect(progress().keyframes.forest).toMatchObject({
			status: 'done',
			file: 'keyframes/forest.png'
		});
		expect(h.steps[KEYFRAMES].status).toBe('succeeded');
		expect(h.steps[KEYFRAMES].output).toContain('- snow: keyframes/snow.png (drawn)');
		expect(h.steps[KEYFRAMES].output).toContain(
			'- forest, re-anchor at clip 6: keyframes/forest-r6.png (an edit of its keyframe)'
		);
		expect(h.steps[KEYFRAMES].output).toContain(
			`![snow, clip 6](haruspex-img://localhost/${'f'.repeat(64)})`
		);
		expect(asked.questions).toEqual([]);
	});

	it('keeps what the last run made, and redraws one whose file is gone', async () => {
		await run(harness(), foxSpec());
		image.requests = [];
		const h = harness();
		await run(h, foxSpec());
		expect(image.requests).toEqual([]);
		expect(h.steps[KEYFRAMES].output).toContain(
			'- snow: keyframes/snow.png (kept from the last run)'
		);

		bytes.delete('ep1/keyframes/forest-r6.png');
		const again = harness();
		const stills = await run(again, foxSpec());
		expect(image.requests).toHaveLength(1);
		expect(stills.find((s) => s.id === 'forest-r6')?.how).toBe('edited');
		expect(bytes.has('ep1/keyframes/forest-r6.png')).toBe(true);
	});

	it('makes no stills without an image backend, and asks nothing when attended', async () => {
		image.kind = 'none';
		const h = harness();
		const stills = await run(h, foxSpec(), { attended: true });
		expect(stills).toEqual([]);
		expect(image.requests).toEqual([]);
		expect(asked.questions).toEqual([]);
		expect(h.steps[KEYFRAMES].output).toBe(
			'No keyframes: each generated section opens from its prompt alone.'
		);
	});

	it('makes no stills when sections start from their prompts', async () => {
		const h = harness();
		const stills = await run(h, foxSpec(), { draws: false });
		expect(stills).toEqual([]);
		expect(image.requests).toEqual([]);
		expect(h.steps[KEYFRAMES].status).toBe('succeeded');
	});

	it('draws each section afresh and reuses it to re-anchor when nothing can edit', async () => {
		image.canEdit = false;
		const h = harness();
		const stills = await run(h, foxSpec());
		expect(image.requests).toHaveLength(2);
		expect(image.requests.every((r) => r.edit === undefined)).toBe(true);
		expect(stills.filter((s) => s.how === 'reused').map((s) => s.file)).toEqual([
			'keyframes/snow.png',
			'keyframes/snow.png',
			'keyframes/forest.png',
			'keyframes/forest.png'
		]);
		const output = h.steps[KEYFRAMES].output!;
		expect(output).toContain('(the section keyframe again)');
		// A reused still is the keyframe again: it is shown once, not per clip.
		expect(output.match(/!\[/g)).toHaveLength(2);
	});

	it('uses the user’s pictures as they are, and does not stop to ask about them', async () => {
		bytes.set('ep1/snow.png', new Uint8Array([3]));
		const h = harness();
		const stills = await run(h, ownPictures(), { attended: true });
		expect(image.requests).toEqual([]);
		expect(asked.questions).toEqual([]);
		expect(stills.slice(0, 2)).toEqual([
			{ id: 'snow', section: 'snow', file: 'snow.png', how: 'user' },
			{ id: 'forest', section: 'forest', file: 'forest.png', how: 'user' }
		]);
		const output = h.steps[KEYFRAMES].output!;
		expect(output).toContain('- forest: forest.png (your picture)');
		// forest.png is not in the folder: it is listed, with no picture to show.
		expect(output).toContain('![snow](');
		expect(output).not.toContain('![forest](');
	});

	it('stops at the stills when attended and goes on with them on Approve', async () => {
		asked.answers = [{ kind: 'selected', labels: ['Approve'] }];
		const h = harness();
		const stills = await run(h, foxSpec(), { attended: true });
		expect(stills).toHaveLength(6);
		expect(asked.questions).toHaveLength(1);
		const q = asked.questions[0];
		expect(q.runId).toBe(9);
		expect(q.question).toBe('Every clip starts from these stills. Approve them?');
		expect(q.images?.map((i) => i.alt)).toEqual([
			'snow',
			'forest',
			'snow, clip 6',
			'snow, clip 12',
			'forest, clip 6',
			'forest, clip 12'
		]);
		expect(q.options.map((o) => o.label)).toEqual(['Approve', 'Redo one', 'Stop']);
		expect(h.steps[KEYFRAMES].status).toBe('succeeded');
	});

	it('ends the run on Stop, with the stills it made recorded', async () => {
		asked.answers = [{ kind: 'selected', labels: ['Stop'] }];
		const h = harness();
		await expect(run(h, foxSpec(), { attended: true })).rejects.toMatchObject({
			name: 'AbortError'
		});
		expect(h.steps[KEYFRAMES].status).toBe('running');
		expect(progress().keyframes.snow.status).toBe('done');
	});

	it('remakes the section picked, with the note in its prompt, then asks again', async () => {
		asked.answers = [
			{ kind: 'selected', labels: ['Redo one'] },
			{ kind: 'selected', labels: ['forest'], note: 'at dusk' },
			{ kind: 'selected', labels: ['Approve'] }
		];
		const h = harness();
		await run(h, foxSpec(), { attended: true });
		expect(asked.questions[1].question).toBe('Which section’s still should be made again?');
		expect(asked.questions[1].options.map((o) => o.label)).toEqual(['snow', 'forest']);
		const redone = image.requests.slice(6);
		// forest and its two re-anchors; snow and its re-anchors are kept.
		expect(redone).toHaveLength(3);
		expect(redone[0].prompt).toContain('a fox in a sunny summer forest. at dusk');
		expect(asked.questions).toHaveLength(3);
		expect(h.steps[KEYFRAMES].output).toContain(
			'- snow: keyframes/snow.png (kept from the last run)'
		);
	});

	it('takes the note from free text, and the section from text that names it', async () => {
		asked.answers = [
			{ kind: 'freeText', text: 'warmer light' },
			{ kind: 'freeText', text: 'the snow one, at night' },
			{ kind: 'selected', labels: ['Approve'] }
		];
		await run(harness(), foxSpec(), { attended: true });
		const redone = image.requests.slice(6);
		expect(redone).toHaveLength(3);
		expect(redone[0].prompt).toBe(
			'a fox walking through deep snow. warmer light the snow one, at night. a red fox, natural light, documentary look'
		);
	});

	it('asks again, remaking nothing, when the answer names no section', async () => {
		asked.answers = [
			{ kind: 'selected', labels: ['Redo one'] },
			{ kind: 'freeText', text: 'the middle one' },
			{ kind: 'selected', labels: ['Approve'] }
		];
		await run(harness(), foxSpec(), { attended: true });
		expect(image.requests).toHaveLength(6);
		expect(asked.questions.map((q) => q.question)).toEqual([
			'Every clip starts from these stills. Approve them?',
			'Which section’s still should be made again?',
			'Every clip starts from these stills. Approve them?'
		]);
	});

	it('stops offering a redo after five, and ends the run on one asked for anyway', async () => {
		for (let i = 0; i < 5; i++) {
			asked.answers.push(
				{ kind: 'selected', labels: ['Redo one'] },
				{ kind: 'selected', labels: ['snow'] }
			);
		}
		asked.answers.push({ kind: 'freeText', text: 'once more' });
		await expect(run(harness(), foxSpec(), { attended: true })).rejects.toMatchObject({
			name: 'AbortError'
		});
		const approvals = asked.questions.filter((q) => q.question.startsWith('Every clip'));
		expect(approvals).toHaveLength(6);
		expect(approvals[4].options.map((o) => o.label)).toContain('Redo one');
		expect(approvals[5].options.map((o) => o.label)).toEqual(['Approve', 'Stop']);
	});

	it('offers no redo when only a drawn portrait is new', async () => {
		const spec = presenterSpec();
		spec.sections = spec.sections.map((s) =>
			s.kind === 'generated' ? { ...s, start_image: `${s.id}.png` } : s
		);
		asked.answers = [{ kind: 'selected', labels: ['Approve'] }];
		const stills = await run(harness(), spec, { attended: true });
		expect(stills.find((s) => s.id === 'host')?.how).toBe('drawn');
		expect(image.requests[0].prompt).toMatch(/^Portrait of a presenter in a winter coat/);
		expect(asked.questions[0].options.map((o) => o.label)).toEqual(['Approve', 'Stop']);
	});

	it('stops before any picture when the run is already cancelled', async () => {
		const h = harness();
		h.ctx.abort.abort();
		await expect(run(h, foxSpec())).rejects.toMatchObject({ name: 'AbortError' });
		expect(image.requests).toEqual([]);
		expect(h.steps[KEYFRAMES].status).toBe('running');
	});

	it('fails with the backend’s error when a picture can’t be made', async () => {
		image.answer = (n) => {
			if (n === 2) throw new Error('ComfyUI is not running');
			return null;
		};
		const h = harness();
		await expect(run(h, foxSpec())).rejects.toThrow('ComfyUI is not running');
		expect(h.steps[KEYFRAMES].status).toBe('running');
	});

	it('fails naming the still when the backend gives no picture', async () => {
		image.answer = () => ({ images: [], meta: {} });
		await expect(run(harness(), foxSpec())).rejects.toThrow(
			'The image backend gave no picture for snow.'
		);
	});

	it('keeps the stills made before a failure for the next run', async () => {
		image.answer = (n) => {
			if (n === 3) throw new Error('out of memory');
			return null;
		};
		await expect(run(harness(), foxSpec())).rejects.toThrow('out of memory');
		image.answer = null;
		image.requests = [];
		const stills = await run(harness(), foxSpec());
		expect(stills.find((s) => s.id === 'snow')?.how).toBe('kept');
		expect(stills.find((s) => s.id === 'forest')?.how).toBe('kept');
		expect(image.requests).toHaveLength(4);
	});
});
