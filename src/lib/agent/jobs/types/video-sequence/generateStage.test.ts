/**
 * The Generate stage on its own: the video models, the episode's files and
 * the user's answers are stand-ins; `runGenerate`, the plan, the progress
 * file and the step markers are real.
 */
import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { LTX, LTX_MODEL } from '#lib/testing/sequenceSpecs.ts';
import { videoCaps, videoModel } from '#lib/testing/videoModels.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import type { RunStepState } from '#lib/agent/jobs/runner.svelte.ts';
import type { UserAnswer, UserQuestionRequest } from '#lib/stores/userQuestion.svelte.ts';
import type { VideoBackend } from '#lib/videogen/backend.ts';
import type {
	VideoCaps,
	VideoGenerateOptions,
	VideoJobHandle,
	VideoRequest
} from '#lib/videogen/types.ts';
import { fitClip } from '#lib/videogen/fit.ts';
import { videoSrc } from '#lib/videogen/url.ts';
import { stepMarkers } from '#lib/agent/jobs/stepMarkers.ts';
import { planClips, type ClipPlan, type GenerateItem } from '#lib/sequence/spec/plan.ts';
import { itemKeys, mergeProgress } from '#lib/sequence/spec/progress.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';
import { GENERATE } from '#lib/agent/jobs/types/video-sequence/stages.ts';
import { runFiles, writeProgress } from '#lib/agent/jobs/types/video-sequence/files.ts';
import { configDefaults } from '#lib/agent/jobs/types/video-sequence/config.ts';
import type { PickedModel } from '#lib/agent/jobs/types/video-sequence/pick.ts';
import type { Still } from '#lib/agent/jobs/types/video-sequence/keyframes.ts';
import { generateStage, type RunModels } from './generateStage.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
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
vi.mock('#lib/video/binaries.ts', () => ({ videoOverrides: () => ({}) }));
const routed = vi.hoisted(() => ({ to: null as unknown }));
vi.mock('#lib/videogen/route.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/videogen/route.ts')>()),
	routeVideo: async () => {
		if (!routed.to) throw new Error('no other video model');
		return routed.to;
	}
}));
const resumer = vi.hoisted(() => ({ backend: null as unknown }));
vi.mock('#lib/videogen/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/videogen/index.ts')>()),
	videoBackendForEntry: () => resumer.backend
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
		fs_read_bytes: (a) => {
			const v = bytes.get(a!.relPath as string);
			if (!v) throw 'missing';
			return Array.from(v);
		},
		fs_path_exists: (a) => bytes.has(a!.relPath as string) || files.has(a!.relPath as string),
		image_store_bytes: () => 'f'.repeat(64),
		audio_cache_import: () => ({ hash: 'c'.repeat(64) }),
		audio_save_in_folder: (a) => {
			bytes.set(a!.relPath as string, new Uint8Array([1]));
		},
		video_still_extract: (a) => {
			const req = a!.request as { out: string };
			bytes.set(req.out, new Uint8Array([2]));
			return { path: req.out, width: 1, height: 1, previewDataUrl: '' };
		}
	});
}

interface Sent {
	req: VideoRequest;
	signal?: AbortSignal;
}

/** A video model whose clips are recorded in `sent`; `fail` makes the nth throw. */
function fakeModel(caps: VideoCaps, name = 'ltx') {
	const sent: Sent[] = [];
	const model = {
		fail: null as null | ((n: number) => Error | null),
		/** Seconds each clip takes, on the faked clock. */
		takes: 0
	};
	const backend = {
		generate: async (req: VideoRequest, opts: VideoGenerateOptions = {}) => {
			if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
			sent.push({ req, signal: opts.signal });
			const e = model.fail?.(sent.length);
			if (e) throw e;
			vi.setSystemTime(Date.now() + model.takes * 1000);
			return {
				hash: 'a'.repeat(64),
				url: '',
				mime: 'video/webm',
				width: req.width,
				height: req.height,
				frames: req.frames,
				fps: req.fps,
				seed: req.seed,
				model: name,
				hasAudio: false
			};
		},
		resume: async () => {
			throw new Error('not this model');
		}
	} as unknown as VideoBackend;
	const picked: PickedModel = {
		entry: videoModel('llama-toolchest', { model: name }),
		caps,
		backend
	};
	return { picked, sent, model };
}

const LTX_LIKE = videoCaps({ limits: LTX, frameStep: LTX_MODEL.frameStep, endImage: true });

/** One generated section of `seconds`: 8 s is two clips on LTX. */
function snowSpec(
	seconds = 8,
	extra: Partial<SequenceSpec['sections'][number]> = {}
): SequenceSpec {
	return {
		version: 1,
		title: 'Snow',
		style: '',
		sections: [
			{
				kind: 'generated',
				id: 'snow',
				prompt: 'a fox walking through deep snow',
				seconds,
				...extra
			} as SequenceSpec['sections'][number]
		],
		joins: [],
		sound: { clip_sound: true, music: [], narration: [] },
		reanchor_every: 0
	};
}

interface Harness {
	ctx: JobRunContext;
	steps: Array<Partial<RunStepState>>;
	written: SequenceSpec[];
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
		stepAuthored: () => '',
		visionSupported: () => false
	} as unknown as JobRunContext;
	return { ctx, steps, written: [] };
}

const cfg = { ...configDefaults(), episode_dir: 'ep1', vision_checks: false };

function run(
	h: Harness,
	spec: SequenceSpec,
	models: RunModels,
	opts: { attended?: boolean; keyframes?: boolean; stills?: Still[]; plan?: ClipPlan } = {}
) {
	const keyframes = opts.keyframes ?? false;
	const plan = opts.plan ?? planClips(spec, models.video.caps, keyframes);
	return generateStage(h.ctx, stepMarkers(h.ctx), cfg, runFiles(h.ctx, cfg), {
		spec,
		plan,
		limits: models.video.caps.limits,
		keyframes,
		stills: opts.stills ?? [],
		attended: opts.attended ?? false,
		models,
		writeSpec: async (next) => {
			h.written.push(next);
		}
	});
}

const progress = () => JSON.parse(files.get('ep1/.haruspex/sequence-progress.json')!);
const titles = (sent: Sent[]) => sent.map((s) => s.req.title);

beforeEach(() => {
	vi.useFakeTimers();
	files = new Map();
	bytes = new Map();
	asked.questions = [];
	asked.answers = [];
	routed.to = null;
	resumer.backend = null;
	vi.mocked(invoke).mockImplementation(routes());
});

afterEach(() => {
	vi.useRealTimers();
});

describe('generateStage', () => {
	it('makes every clip into the episode folder and records each', async () => {
		const video = fakeModel(LTX_LIKE);
		const h = harness();
		const spec = snowSpec();
		const made = await run(h, spec, { video: video.picked, speaking: null, automatic: false });
		expect(titles(video.sent)).toEqual(['snow-01', 'snow-02']);
		// The second clip starts from the true last frame of the first.
		expect(video.sent[1].req.startImage).toEqual({
			name: 'snow-01-last.png',
			hash: 'f'.repeat(64)
		});
		expect(video.sent.every((s) => s.signal === h.ctx.abort.signal)).toBe(true);
		expect(bytes.has('ep1/generated/snow-01.webm')).toBe(true);
		expect(bytes.has('ep1/generated/snow-02.webm')).toBe(true);
		expect(progress().clips['snow-02']).toMatchObject({
			status: 'done',
			file: 'generated/snow-02.webm'
		});
		expect(made.outcome).toEqual({ kind: 'done', made: 2, kept: 0, secsPerClip: 0 });
		expect(made.spec).toBe(spec);
		expect(h.steps[GENERATE].status).toBe('succeeded');
		expect(h.steps[GENERATE].output).toBe('2 clips made, 0 kept from before, in ep1/generated.');
		expect(asked.questions).toEqual([]);
		expect(h.written).toEqual([]);
	});

	it('says how long the first clip took', async () => {
		const video = fakeModel(LTX_LIKE);
		video.model.takes = 180;
		const h = harness();
		await run(h, snowSpec(), { video: video.picked, speaking: null, automatic: false });
		expect(h.steps[GENERATE].output).toBe(
			'2 clips made, 0 kept from before, in ep1/generated. The first took 3 min.'
		);
	});

	it('keeps the clips a run already made', async () => {
		const video = fakeModel(LTX_LIKE);
		const models = { video: video.picked, speaking: null, automatic: false };
		await run(harness(), snowSpec(), models);
		video.sent.length = 0;
		const h = harness();
		const made = await run(h, snowSpec(), models);
		expect(video.sent).toEqual([]);
		expect(made.outcome).toMatchObject({ made: 0, kept: 2 });
		expect(h.steps[GENERATE].output).toBe('0 clips made, 2 kept from before, in ep1/generated.');
	});

	it('follows a clip left in flight on the server instead of making it again', async () => {
		const video = fakeModel(LTX_LIKE);
		const spec = snowSpec(5);
		const plan = planClips(spec, LTX_LIKE, false);
		const p = mergeProgress(null, spec, plan);
		const handle: VideoJobHandle = {
			backend: 'llama-toolchest',
			baseUrl: 'http://box:3000',
			id: 'job-1',
			model: 'ltx',
			keyId: ''
		};
		p.clips['snow-01'] = {
			key: itemKeys(spec, plan)['snow-01'],
			status: 'running',
			handle,
			seed: 5
		};
		const h = harness();
		await writeProgress(runFiles(h.ctx, cfg), p);
		const followed: VideoJobHandle[] = [];
		resumer.backend = {
			resume: async (got: VideoJobHandle, req: VideoRequest) => {
				followed.push(got);
				return { hash: 'b'.repeat(64), mime: 'video/webm', seed: req.seed, hasAudio: true };
			}
		};
		await run(h, spec, { video: video.picked, speaking: null, automatic: false }, { plan });
		expect(followed).toEqual([handle]);
		expect(video.sent).toEqual([]);
		expect(progress().clips['snow-01']).toMatchObject({ status: 'done', seed: 5, hasAudio: true });
	});

	it('makes a clip in flight again when this build can’t follow its server', async () => {
		const video = fakeModel(LTX_LIKE);
		const spec = snowSpec(5);
		const plan = planClips(spec, LTX_LIKE, false);
		const p = mergeProgress(null, spec, plan);
		p.clips['snow-01'] = {
			key: itemKeys(spec, plan)['snow-01'],
			status: 'running',
			handle: { backend: 'llama-toolchest', baseUrl: '', id: 'j', model: 'ltx', keyId: '' },
			seed: 5
		};
		const h = harness();
		await writeProgress(runFiles(h.ctx, cfg), p);
		await run(h, spec, { video: video.picked, speaking: null, automatic: false }, { plan });
		expect(titles(video.sent)).toEqual(['snow-01']);
		expect(video.sent[0].req.seed).toBe(5);
		expect(progress().clips['snow-01'].status).toBe('done');
	});

	it('starts a section from its keyframe still', async () => {
		const video = fakeModel(LTX_LIKE);
		bytes.set('ep1/keyframes/snow.png', new Uint8Array([3]));
		await run(
			harness(),
			snowSpec(5),
			{ video: video.picked, speaking: null, automatic: false },
			{
				keyframes: true,
				stills: [{ id: 'snow', section: 'snow', file: 'keyframes/snow.png', how: 'drawn' }]
			}
		);
		expect(video.sent[0].req.startImage).toEqual({ name: 'snow.png', hash: 'f'.repeat(64) });
	});

	it('fails naming the still when its file is missing, before asking for a clip', async () => {
		const video = fakeModel(LTX_LIKE);
		const h = harness();
		await expect(
			run(
				h,
				snowSpec(5),
				{ video: video.picked, speaking: null, automatic: false },
				{
					keyframes: true,
					stills: [{ id: 'snow', section: 'snow', file: 'keyframes/snow.png', how: 'kept' }]
				}
			)
		).rejects.toThrow('ep1/keyframes/snow.png is missing.');
		expect(video.sent).toEqual([]);
		expect(h.steps[GENERATE].status).toBe('running');
	});

	it('tries a failed clip once more on a new seed', async () => {
		const video = fakeModel(LTX_LIKE);
		video.model.fail = (n) => (n === 1 ? new Error('CUDA error') : null);
		await run(harness(), snowSpec(5), { video: video.picked, speaking: null, automatic: false });
		expect(titles(video.sent)).toEqual(['snow-01', 'snow-01']);
		expect(progress().clips['snow-01']).toMatchObject({
			status: 'done',
			seed: video.sent[1].req.seed
		});
	});

	it('fails a clip that fails twice, and records it as failed', async () => {
		const video = fakeModel(LTX_LIKE);
		video.model.fail = () => new Error('CUDA error');
		const h = harness();
		await expect(
			run(h, snowSpec(), { video: video.picked, speaking: null, automatic: false })
		).rejects.toThrow('Clip snow-01 failed twice: CUDA error');
		expect(progress().clips['snow-01'].status).toBe('failed');
		expect(progress().clips['snow-02']).toBeUndefined();
		expect(h.steps[GENERATE].status).toBe('running');
	});

	it('waits a minute and sends the same clip again when the model could not start', async () => {
		const video = fakeModel(LTX_LIKE);
		video.model.fail = (n) => (n === 1 ? new Error('failed to load the model') : null);
		const h = harness();
		const going = run(h, snowSpec(5), { video: video.picked, speaking: null, automatic: false });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.steps[GENERATE].output).toMatch(
			/could not start the model; trying again in a minute$/
		);
		expect(video.sent).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(60_000);
		const made = await going;
		expect(made.outcome).toMatchObject({ made: 1 });
		expect(video.sent[1].req.seed).toBe(video.sent[0].req.seed);
	});

	it('stops when the run is cancelled while it waits for the model', async () => {
		const video = fakeModel(LTX_LIKE);
		video.model.fail = (n) => (n === 1 ? new Error('failed to load the model') : null);
		const h = harness();
		const going = run(h, snowSpec(5), { video: video.picked, speaking: null, automatic: false });
		const settled = expect(going).rejects.toMatchObject({ name: 'AbortError' });
		await vi.advanceTimersByTimeAsync(0);
		h.ctx.abort.abort();
		await settled;
		expect(bytes.has('ep1/generated/snow-01.webm')).toBe(false);
		expect(h.steps[GENERATE].status).toBe('running');
	});

	it('sends nothing more once the run is cancelled during the wait', async () => {
		const video = fakeModel(LTX_LIKE);
		video.model.fail = (n) => (n === 1 ? new Error('failed to load the model') : null);
		const sends: VideoRequest[] = [];
		const leaky = {
			...video.picked,
			backend: {
				...video.picked.backend,
				generate: async (req: VideoRequest) => {
					sends.push(req);
					throw new Error('failed to load the model');
				}
			}
		};
		const h = harness();
		const going = run(h, snowSpec(5), { video: leaky, speaking: null, automatic: false });
		const settled = expect(going).rejects.toMatchObject({ name: 'AbortError' });
		await vi.advanceTimersByTimeAsync(0);
		h.ctx.abort.abort();
		await vi.advanceTimersByTimeAsync(0);
		expect(sends).toHaveLength(1);
		await settled;
	});

	it('stops before any clip when the run is already cancelled', async () => {
		const video = fakeModel(LTX_LIKE);
		const h = harness();
		h.ctx.abort.abort();
		await expect(
			run(h, snowSpec(), { video: video.picked, speaking: null, automatic: false })
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(video.sent).toEqual([]);
		expect(h.steps[GENERATE].status).toBe('running');
	});

	describe('a speaking window', () => {
		function windowPlan(spec: SequenceSpec): ClipPlan {
			const plan = planClips(spec, LTX_LIKE, false);
			const item = plan.items[0] as GenerateItem;
			item.audio = { parts: [], out: 'speech/host-01.wav' } as unknown as GenerateItem['audio'];
			return plan;
		}

		it('goes to the speaking model, with its speech', async () => {
			const video = fakeModel(LTX_LIKE);
			const speaker = fakeModel(videoCaps({ speech: true }), 's2v');
			const spec = snowSpec(5);
			await run(
				harness(),
				spec,
				{ video: video.picked, speaking: speaker.picked, automatic: false },
				{ plan: windowPlan(spec) }
			);
			expect(video.sent).toEqual([]);
			expect(speaker.sent[0].req).toMatchObject({
				audio: { name: 'host-01.wav', hash: 'c'.repeat(64) },
				followAudio: true
			});
		});

		it('fails without a speaking model', async () => {
			const video = fakeModel(LTX_LIKE);
			const spec = snowSpec(5);
			await expect(
				run(
					harness(),
					spec,
					{ video: video.picked, speaking: null, automatic: false },
					{ plan: windowPlan(spec) }
				)
			).rejects.toThrow('Speaking sections need a speaking model.');
			expect(video.sent).toEqual([]);
		});
	});

	describe('a clip the video model can’t make', () => {
		const textOnly = videoCaps({ limits: LTX, frameStep: 8, startImage: false });

		it('goes to another model on Automatic, sized for that one', async () => {
			const video = fakeModel(textOnly);
			const wan = fakeModel(videoCaps(), 'wan');
			routed.to = { entry: wan.picked.entry, caps: wan.picked.caps, backend: wan.picked.backend };
			await run(harness(), snowSpec(8), { video: video.picked, speaking: null, automatic: true });
			// The first clip is from the prompt; the second starts from a picture.
			expect(titles(video.sent)).toEqual(['snow-01']);
			expect(titles(wan.sent)).toEqual(['snow-02']);
			const plan = planClips(snowSpec(8), textOnly, false);
			const second = plan.items[1] as GenerateItem;
			const fit = fitClip(
				wan.picked.caps.limits,
				wan.picked.entry.name,
				{ seconds: second.frames / plan.fps, portrait: false },
				wan.picked.caps.frameStep
			);
			expect(wan.sent[0].req).toMatchObject({
				width: fit.width,
				height: fit.height,
				frames: fit.frames,
				fps: fit.fps
			});
		});

		it('stays on the job’s own model when one is named', async () => {
			const video = fakeModel(textOnly);
			const wan = fakeModel(videoCaps(), 'wan');
			routed.to = { entry: wan.picked.entry, caps: wan.picked.caps, backend: wan.picked.backend };
			await run(harness(), snowSpec(8), { video: video.picked, speaking: null, automatic: false });
			expect(titles(video.sent)).toEqual(['snow-01', 'snow-02']);
			expect(wan.sent).toEqual([]);
		});
	});

	describe('attended', () => {
		const models = () => {
			const video = fakeModel(LTX_LIKE);
			return { video, models: { video: video.picked, speaking: null, automatic: false } };
		};

		it('stops after a section’s first clip and goes on after Continue', async () => {
			const { video, models: m } = models();
			asked.answers = [{ kind: 'selected', labels: ['Continue'] }];
			const h = harness();
			const made = await run(h, snowSpec(), m, { attended: true });
			expect(asked.questions).toHaveLength(1);
			expect(asked.questions[0]).toMatchObject({
				runId: 9,
				question: 'The first clip of snow. Go on with the section?',
				body: `![snow](${videoSrc('a'.repeat(64))})`
			});
			expect(titles(video.sent)).toEqual(['snow-01', 'snow-02']);
			expect(made.outcome).toMatchObject({ kind: 'done', made: 2 });
		});

		it('ends the run on Stop, keeping the clip made', async () => {
			const { video, models: m } = models();
			asked.answers = [{ kind: 'selected', labels: ['Stop'] }];
			const h = harness();
			await expect(run(h, snowSpec(), m, { attended: true })).rejects.toMatchObject({
				name: 'AbortError'
			});
			expect(titles(video.sent)).toEqual(['snow-01']);
			expect(progress().clips['snow-01'].status).toBe('done');
			expect(h.steps[GENERATE].status).toBe('running');
		});

		it('writes a note into the spec and makes the section again from it', async () => {
			const { video, models: m } = models();
			asked.answers = [
				{ kind: 'freeText', text: 'the fox walks slower' },
				{ kind: 'selected', labels: ['Continue'] }
			];
			const h = harness();
			const made = await run(h, snowSpec(), m, { attended: true });
			const section = made.spec.sections[0];
			expect(section).toMatchObject({
				prompt: 'a fox walking through deep snow. the fox walks slower',
				keyframe_prompt: 'a fox walking through deep snow'
			});
			expect(h.written).toEqual([made.spec]);
			expect(titles(video.sent)).toEqual(['snow-01', 'snow-01', 'snow-02']);
			expect(video.sent[1].req.prompt).toContain('the fox walks slower');
			expect(asked.questions).toHaveLength(2);
			expect(h.steps[GENERATE].output).toMatch(/^2 clips made/);
		});

		it('makes the clip again on a new seed for Redo it with no note', async () => {
			const { video, models: m } = models();
			asked.answers = [
				{ kind: 'selected', labels: ['Redo it'] },
				{ kind: 'selected', labels: ['Continue'] }
			];
			const h = harness();
			const spec = snowSpec();
			const made = await run(h, spec, m, { attended: true });
			expect(h.written).toEqual([]);
			expect(made.spec).toBe(spec);
			expect(titles(video.sent)).toEqual(['snow-01', 'snow-01', 'snow-02']);
			expect(video.sent[1].req.seed).not.toBe(video.sent[0].req.seed);
			expect(video.sent[1].req.prompt).toBe(video.sent[0].req.prompt);
		});

		it('takes the note given with Redo it', async () => {
			const { models: m } = models();
			asked.answers = [
				{ kind: 'selected', labels: ['Redo it'], note: 'more snow falling' },
				{ kind: 'selected', labels: ['Continue'] }
			];
			const h = harness();
			const made = await run(h, snowSpec(), m, { attended: true });
			expect(made.spec.sections[0]).toMatchObject({
				prompt: 'a fox walking through deep snow. more snow falling'
			});
		});

		it('stops asking after five notes and makes the rest', async () => {
			const { video, models: m } = models();
			asked.answers = [1, 2, 3, 4, 5].map((n) => ({ kind: 'freeText', text: `note ${n}` }));
			const h = harness();
			const made = await run(h, snowSpec(), m, { attended: true });
			expect(asked.questions).toHaveLength(5);
			expect(h.written).toHaveLength(5);
			expect(made.spec.sections[0]).toMatchObject({
				prompt: 'a fox walking through deep snow. note 1. note 2. note 3. note 4. note 5'
			});
			expect(titles(video.sent).filter((t) => t === 'snow-01')).toHaveLength(6);
			expect(made.outcome.kind).toBe('done');
		});
	});
});
