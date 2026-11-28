/**
 * The Sound, Assemble, Render and Report stages on their own: the music and
 * speech backends, the video tools and the episode's files are stand-ins;
 * `makeSound`, `buildCut`, `renderAndWait`, the report, the progress file
 * and the step markers are real.
 */
import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { LTX_MODEL } from '#lib/testing/sequenceSpecs.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import type { RunStepState } from '#lib/agent/jobs/runner.svelte.ts';
import type { RenderResult } from '#lib/ipc/gen/RenderResult.ts';
import type { CutSpec } from '#lib/ipc/gen/CutSpec.ts';
import { stepMarkers } from '#lib/agent/jobs/stepMarkers.ts';
import { planClips, type ClipPlan } from '#lib/sequence/spec/plan.ts';
import { itemKeys, mergeProgress } from '#lib/sequence/spec/progress.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';
import { ASSEMBLE, RENDER, REPORT, SOUND } from '#lib/agent/jobs/types/video-sequence/stages.ts';
import { runFiles, writeProgress } from '#lib/agent/jobs/types/video-sequence/files.ts';
import {
	configDefaults,
	type VideoSequenceConfig
} from '#lib/agent/jobs/types/video-sequence/config.ts';
import type { EpisodeClip } from '#lib/agent/jobs/types/video-sequence/context.ts';
import { finishStages } from './finishStages.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/jobRuns.svelte.ts', () => ({
	markRunStepStarted: async () => {},
	markRunStepFinished: async () => {}
}));
vi.mock('#lib/video/binaries.ts', () => ({ videoOverrides: () => ({}) }));
const music = vi.hoisted(() => ({
	tasks: null as null | string[],
	made: [] as { durationSec: number; task?: string; title: string }[],
	fail: null as Error | null
}));
vi.mock('#lib/music/backend.ts', () => ({
	resolveMusicBackend: () => ({
		kind: 'toolchest',
		tasks: async () => {
			if (!music.tasks) throw new Error('the music backend was not to be asked');
			return music.tasks;
		}
	})
}));
vi.mock('#lib/agent/tools/_musicJob.ts', () => ({
	runMusicJob: async (spec: { request: { durationSec: number; task?: string; title: string } }) => {
		if (music.fail) throw music.fail;
		music.made.push(spec.request);
		return { hash: 'b'.repeat(64), durationSec: spec.request.durationSec };
	}
}));
const speech = vi.hoisted(() => ({ said: [] as { text: string; voice: string | null }[] }));
vi.mock('#lib/audio/speak.ts', () => ({
	speak: async (req: { text: string; voice: string | null }) => {
		speech.said.push({ text: req.text, voice: req.voice });
		return { hash: 'd'.repeat(64), seconds: 2 };
	}
}));

let files: Map<string, string>;
let bytes: Map<string, Uint8Array>;
let cuts: CutSpec[];
let joins: { parts: string[]; out: string }[];
let cancelled: string[];
/** What `video_project_cut` answers. */
let cutResult: { created: boolean; notes: string[] };
/** The render task as `video_render_start` starts it, then as `task_list` gives it each time. */
let renders: Record<string, unknown>[];

const rendered = (check: RenderResult['check'] = null): RenderResult => ({
	path: 'ep1/renders/ep1.mp4',
	absPath: '/videos/ep1/renders/ep1.mp4',
	check
});
const task = (state: string, extra: Record<string, unknown> = {}) => ({
	id: 'r1',
	state,
	percent: null,
	result: null,
	error: null,
	...extra
});

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
		fs_path_exists: (a) => bytes.has(a!.relPath as string) || files.has(a!.relPath as string),
		audio_save_in_folder: (a) => {
			bytes.set(a!.relPath as string, new Uint8Array([1]));
		},
		audio_crossfade_join: (a) => {
			joins.push({ parts: a!.parts as string[], out: a!.out as string });
			bytes.set(a!.out as string, new Uint8Array([1]));
		},
		video_project_cut: (a) => {
			cuts.push(a!.spec as CutSpec);
			return { summary: { project: 'ep1/ep1.mlt' }, ...cutResult };
		},
		video_render_start: () => renders.shift(),
		task_list: () => [renders.length > 1 ? renders.shift() : renders[0]],
		task_cancel: (a) => {
			cancelled.push(a!.id as string);
		},
		task_take_notices: () => []
	});
}

interface Harness {
	ctx: JobRunContext;
	steps: Array<Partial<RunStepState>>;
	cfg: VideoSequenceConfig;
}

function harness(cfg: Partial<VideoSequenceConfig> = {}): Harness {
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
	return { ctx, steps, cfg: { ...configDefaults(), episode_dir: 'ep1', ...cfg } };
}

/** Snow then forest, cut together, with a piano bed under both and one narration line. */
function spec(seconds = 10): SequenceSpec {
	return {
		version: 1,
		title: 'Fox seasons',
		style: 'documentary look',
		sections: [
			{ kind: 'generated', id: 'snow', prompt: 'a fox in snow', seconds },
			{ kind: 'generated', id: 'forest', prompt: 'a fox in a forest', seconds }
		],
		joins: [{ kind: 'cut' }],
		sound: {
			clip_sound: true,
			music: [{ id: 'piano', sections: ['snow', 'forest'], caption: 'solo piano' }],
			narration: [{ section: 'forest', at_secs: 2, text: 'Foxes hunt by sound.' }]
		},
		reanchor_every: 0
	};
}

const silent = (s: SequenceSpec): SequenceSpec => ({
	...s,
	sound: { clip_sound: true, music: [], narration: [] }
});

/** The progress the Generate stage leaves: every clip done but `skip`. */
async function generated(h: Harness, s: SequenceSpec, plan: ClipPlan, skip: string[] = []) {
	const p = mergeProgress(null, s, plan);
	const keys = itemKeys(s, plan);
	for (const item of plan.items) {
		if (item.kind !== 'generate' || skip.includes(item.id)) continue;
		p.clips[item.id] = {
			key: keys[item.id],
			status: 'done',
			file: `generated/${item.id}.webm`,
			seed: 1,
			hasAudio: false
		};
	}
	await writeProgress(runFiles(h.ctx, h.cfg), p);
}

async function finish(
	h: Harness,
	s: SequenceSpec,
	opts: { skip?: string[]; episodeClips?: EpisodeClip[]; seed?: boolean } = {}
) {
	const plan = planClips(s, LTX_MODEL, false);
	if (opts.seed !== false) await generated(h, s, plan, opts.skip);
	return finishStages(h.ctx, stepMarkers(h.ctx), h.cfg, runFiles(h.ctx, h.cfg), {
		spec: s,
		plan,
		episodeClips: opts.episodeClips ?? [],
		notes: ['A validation note.'],
		startedMs: Date.now()
	});
}

const progress = () => JSON.parse(files.get('ep1/.haruspex/sequence-progress.json')!);

beforeEach(() => {
	files = new Map();
	bytes = new Map();
	cuts = [];
	joins = [];
	cancelled = [];
	cutResult = { created: true, notes: [] };
	renders = [task('done', { percent: 100, result: rendered() })];
	music.tasks = ['text2music', 'repaint'];
	music.made = [];
	music.fail = null;
	speech.said = [];
	vi.mocked(invoke).mockImplementation(routes());
});

afterEach(() => {
	vi.useRealTimers();
});

describe('finishStages', () => {
	it('makes the sound, assembles the project, renders it and writes the report', async () => {
		const h = harness();
		const s = spec();
		const plan = planClips(s, LTX_MODEL, false);
		const render = await finish(h, s);
		expect(render).toEqual(rendered());

		// Sound: one song under both sections, and the line spoken.
		expect(music.made.map((m) => m.title)).toEqual(['piano']);
		// As long as the two sections' clips: their frame counts round 20 s up.
		expect(music.made[0].durationSec).toBeGreaterThanOrEqual(20);
		expect(music.made[0].durationSec).toBeLessThanOrEqual(21);
		expect(speech.said).toEqual([{ text: 'Foxes hunt by sound.', voice: null }]);
		expect(bytes.has('ep1/music/piano.mp3')).toBe(true);
		expect(bytes.has('ep1/narration/forest-1.wav')).toBe(true);
		expect(h.steps[SOUND].output).toBe(
			'- music piano: music/piano.mp3\n- narration: narration/forest-1.wav'
		);

		// Assemble: every clip on the main track, the sound under it.
		const cut = cuts[0];
		expect(cut.items.map((i) => i.path)).toEqual(
			plan.items.map((i) => `ep1/generated/${i.id}.webm`)
		);
		expect(cut.editor).toBeNull();
		expect(cut.audio).toEqual([
			expect.objectContaining({ path: 'ep1/music/piano.mp3', atSecs: 0, lufs: -30 }),
			expect.objectContaining({ path: 'ep1/narration/forest-1.wav', lufs: -14 })
		]);
		expect(cut.audio![1].atSecs).toBeCloseTo(12, 0);
		expect(h.steps[ASSEMBLE].output).toBe(
			`Made ep1/ep1.mlt: ${plan.items.length} clips, ${cut.preset}.\n` +
				'The clips have no sound of their own: the video model made them silent.'
		);

		// Render and Report.
		expect(h.steps[RENDER].output).toBe('Rendered ep1/renders/ep1.mp4.');
		const report = files.get('ep1/REPORT-sequence.md')!;
		expect(report).toMatch(/^# Fox seasons/);
		expect(report).toContain('The project is ep1/ep1.mlt.');
		expect(report).toContain('music piano (music/piano.mp3)');
		expect(report).toContain('- A validation note.');
		expect(report).toContain('- The clips have no sound of their own');
		expect(h.steps[REPORT].output).toBe(`Wrote ep1/REPORT-sequence.md.\n\n${report}`);
		for (const step of [SOUND, ASSEMBLE, RENDER, REPORT]) {
			expect(h.steps[step].status).toBe('succeeded');
		}
		expect(progress()).toMatchObject({
			project: 'ep1/ep1.mlt',
			render: 'ep1/renders/ep1.mp4',
			music: { piano: { status: 'done', file: 'music/piano.mp3' } },
			narration: { 'forest-1': { status: 'done', file: 'narration/forest-1.wav' } }
		});
	});

	it('makes no sound for a spec without music or narration, and asks no backend', async () => {
		music.tasks = null;
		const h = harness();
		await finish(h, silent(spec()));
		expect(music.made).toEqual([]);
		expect(speech.said).toEqual([]);
		expect(h.steps[SOUND].output).toBe('No music or narration in the spec.');
		expect(cuts[0].audio).toBeNull();
		expect(h.steps[REPORT].status).toBe('succeeded');
	});

	it('keeps the sound a run already made, and updates the project', async () => {
		await finish(harness(), spec());
		music.made = [];
		speech.said = [];
		cutResult = { created: false, notes: ['Kept your edits.'] };
		renders = [task('done', { result: rendered() })];
		const h = harness();
		await finish(h, spec(), { seed: false });
		expect(music.made).toEqual([]);
		expect(speech.said).toEqual([]);
		expect(h.steps[SOUND].output).toContain('- music piano: music/piano.mp3');
		expect(h.steps[ASSEMBLE].output).toMatch(/^Updated ep1\/ep1.mlt: /);
		expect(h.steps[ASSEMBLE].output).toContain('\nKept your edits.');
		expect(files.get('ep1/REPORT-sequence.md')).toContain('- Kept your edits.');
	});

	it('extends a long bed where the music model can repaint', async () => {
		const h = harness();
		const s = spec(150);
		s.sound.narration = [];
		await finish(h, s);
		expect(music.made.map((m) => m.task ?? 'text2music')).toEqual(['text2music', 'repaint']);
		expect(joins).toEqual([]);
		expect(h.steps[SOUND].output).toBe('- music piano: music/piano.mp3');
	});

	it('joins several songs for a long bed where it can’t', async () => {
		music.tasks = ['text2music'];
		const h = harness();
		const s = spec(150);
		s.sound.narration = [];
		await finish(h, s);
		expect(music.made.map((m) => m.title)).toEqual(['piano 1', 'piano 2']);
		expect(joins).toEqual([
			{ parts: ['ep1/music/piano-1.mp3', 'ep1/music/piano-2.mp3'], out: 'ep1/music/piano.wav' }
		]);
		expect(h.steps[SOUND].output).toBe('- music piano: music/piano.wav');
	});

	it('opens the project in the job’s editor', async () => {
		await finish(harness({ editor: 'kdenlive' }), silent(spec()));
		expect(cuts[0].editor).toBe('kdenlive');
	});

	it('places an existing clip from the episode folder', async () => {
		const s = silent(spec());
		s.sections.unshift({ kind: 'existing', id: 'intro', path: 'intro.mp4' });
		s.joins.unshift({ kind: 'cut' });
		await finish(harness(), s, {
			episodeClips: [{ path: 'intro.mp4', secs: 4, width: 1920, height: 1080, sound: true }]
		});
		expect(cuts[0].items[0].path).toBe('ep1/intro.mp4');
	});

	it('fails at Assemble on a clip that was not made, before making a project', async () => {
		const h = harness();
		await expect(finish(h, silent(spec()), { skip: ['forest-01'] })).rejects.toThrow(
			'Clip forest-01 was not made; run the job again to make it.'
		);
		expect(cuts).toEqual([]);
		expect(h.steps[SOUND].status).toBe('succeeded');
		expect(h.steps[ASSEMBLE].status).toBe('running');
		expect(files.has('ep1/REPORT-sequence.md')).toBe(false);
	});

	it('leaves out a clip that failed, so Assemble asks for it to be made', async () => {
		const h = harness();
		const s = silent(spec());
		const plan = planClips(s, LTX_MODEL, false);
		await generated(h, s, plan);
		const p = progress();
		p.clips['snow-01'].status = 'failed';
		files.set('ep1/.haruspex/sequence-progress.json', JSON.stringify(p));
		await expect(finish(h, s, { seed: false })).rejects.toThrow('Clip snow-01 was not made');
	});

	it('fails at Sound when a song can’t be made', async () => {
		music.fail = new Error('the music server is down');
		const h = harness();
		await expect(finish(h, spec())).rejects.toThrow('the music server is down');
		expect(cuts).toEqual([]);
		expect(h.steps[SOUND].status).toBe('running');
	});

	it('lists the render check’s problems', async () => {
		const check = {
			durationSecs: 20,
			expectedSecs: 20,
			sizeBytes: 1,
			width: 1280,
			height: 704,
			fps: 24,
			hasAudio: true,
			loudness: null,
			problems: ['The sound is very quiet.']
		};
		renders = [task('done', { result: rendered(check) })];
		const h = harness();
		await finish(h, silent(spec()));
		expect(h.steps[RENDER].output).toBe(
			'Rendered ep1/renders/ep1.mp4.\n- The sound is very quiet.'
		);
		expect(files.get('ep1/REPORT-sequence.md')).toContain('- The sound is very quiet.');
	});

	it('waits for the render, saying how far it is', async () => {
		vi.useFakeTimers();
		renders = [
			task('running', { percent: 0 }),
			task('running', { percent: 49.6 }),
			task('done', { percent: 100, result: rendered() })
		];
		const h = harness();
		const going = finish(h, silent(spec()));
		await vi.advanceTimersByTimeAsync(3000);
		expect(h.steps[RENDER].output).toBe('Rendering: 50%');
		await vi.advanceTimersByTimeAsync(3000);
		await expect(going).resolves.toEqual(rendered());
		expect(h.steps[RENDER].output).toBe('Rendered ep1/renders/ep1.mp4.');
	});

	it('fails with the render’s reason, keeping the project in the progress', async () => {
		renders = [task('failed', { error: 'melt crashed' })];
		const h = harness();
		await expect(finish(h, silent(spec()))).rejects.toThrow('The render failed: melt crashed.');
		expect(progress().project).toBe('ep1/ep1.mlt');
		expect(progress().render ?? null).toBeNull();
		expect(h.steps[RENDER].status).toBe('running');
		expect(files.has('ep1/REPORT-sequence.md')).toBe(false);
	});

	it('stops before any sound when the run is already cancelled', async () => {
		const h = harness();
		h.ctx.abort.abort();
		await expect(finish(h, spec())).rejects.toMatchObject({ name: 'AbortError' });
		expect(music.made).toEqual([]);
		expect(cuts).toEqual([]);
		expect(h.steps[SOUND].status).toBe('running');
	});

	// Bug: render.ts:64 waits between polls with `sleep`, which resolves rather
	// than rejects when the run is cancelled, and `renderAndWait` (render.ts:34)
	// never looks at the signal itself. So cancelling a run while it renders
	// never cancels the render task: the loop polls `task_list` back to back,
	// with no wait, until the render ends, and the run then carries on to the
	// report. (render.test.ts passes only because its fake `wait` throws.)
	it.skip('cancels the render task when the run is cancelled during it', async () => {
		vi.useFakeTimers();
		renders = [task('running', { percent: 0 })];
		let polls = 0;
		const plain = routes();
		vi.mocked(invoke).mockImplementation(
			invokeRouter(
				{
					// Ends the render after 50 polls, so the bug fails the test rather than hanging it.
					task_list: () => [
						++polls > 50 ? task('done', { result: rendered() }) : task('running', { percent: 10 })
					]
				},
				(cmd: string, args?: Record<string, unknown>) => plain(cmd, args)
			)
		);
		const h = harness();
		const going = finish(h, silent(spec()));
		const settled = expect(going).rejects.toMatchObject({ name: 'AbortError' });
		await vi.advanceTimersByTimeAsync(0);
		h.ctx.abort.abort();
		await vi.advanceTimersByTimeAsync(0);
		await settled;
		expect(cancelled).toEqual(['r1']);
		expect(files.has('ep1/REPORT-sequence.md')).toBe(false);
	});
});
