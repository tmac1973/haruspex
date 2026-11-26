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
import {
	ASSEMBLE,
	GENERATE,
	INTERVIEW,
	RENDER,
	KEYFRAMES,
	MAX_DERIVE_ATTEMPTS,
	REPORT,
	SPEC,
	runVideoSequencePipeline
} from './pipeline';
import { SUBMIT_SEQUENCE_SPEC_TOOL } from './tools';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: {
			videoModels: [
				{
					id: 'v',
					name: 'v',
					backend: 'llama-toolchest',
					url: '',
					keyId: null,
					model: 'v',
					options: {},
					caps: null,
					capsAt: null,
					renamed: false
				}
			]
		},
		overDefaults: true
	})
);
const env = vi.hoisted(() => ({ videoTools: true }));
vi.mock('#lib/video/binaries.ts', () => ({
	refreshVideoBinaries: async () => null,
	videoToolsOn: () => env.videoTools,
	videoOverrides: () => ({})
}));
const video = vi.hoisted(() => ({ made: [] as string[] }));
vi.mock('#lib/agent/jobs/types/video-sequence/pick.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/agent/jobs/types/video-sequence/pick.ts')>()),
	pickVideoModel: async () => ({
		entry: { id: 'v', name: 'ltx' },
		caps: {
			text: LTX_CAPS.includes('text'),
			startImage: LTX_CAPS.includes('start_image'),
			endImage: LTX_CAPS.includes('end_image'),
			speech: false,
			needsSpeech: false,
			sound: false,
			limits: LTX,
			frameStep: 4,
			licence: '',
			commercialUse: null
		},
		backend: {
			generate: async (req: { title: string; seed: number }) => {
				video.made.push(req.title);
				return { hash: 'a'.repeat(64), mime: 'video/webm', seed: req.seed, hasAudio: false };
			},
			resume: async () => {
				throw new Error('not in these tests');
			}
		}
	}),
	pickSpeakingModel: async () => null
}));
vi.mock('#lib/image/backend.ts', () => ({ resolveImageBackend: () => ({ kind: 'comfyui' }) }));
const image = vi.hoisted(() => ({ requests: [] as { prompt: string; edit?: unknown }[] }));
vi.mock('#lib/image/route.ts', () => ({
	needOf: () => ({}),
	capableEntries: () => [{}],
	routedImageBackend: () => ({
		generate: async (req: { prompt: string; edit?: unknown }) => {
			image.requests.push(req);
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
vi.mock('#lib/music/backend.ts', () => ({
	resolveMusicBackend: () => ({ kind: 'toolchest', tasks: async () => ['text2music', 'repaint'] })
}));
const music = vi.hoisted(() => ({ made: [] as { durationSec: number; task?: string }[] }));
vi.mock('#lib/agent/tools/_musicJob.ts', () => ({
	runMusicJob: async (spec: { request: { durationSec: number; task?: string } }) => {
		music.made.push(spec.request);
		return { hash: 'b'.repeat(64), durationSec: spec.request.durationSec };
	}
}));
vi.mock('#lib/utils/async.ts', () => ({ sleep: async () => {} }));
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
let cuts: unknown[];
/** Episode folders that exist; `video_episode_ensure` adds to it. */
let dirs: Set<string>;
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
		fs_list_dir: () => ({ entries: [] }),
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
		video_project_cut: (a) => {
			cuts.push(a!.spec);
			return { summary: { project: 'ep1/ep1.mlt' }, notes: [], created: true };
		},
		video_render_start: () => ({ id: 'r1', state: 'running', percent: 0 }),
		task_list: () => [
			{
				id: 'r1',
				state: 'done',
				percent: 100,
				result: { path: 'ep1/renders/ep1.mp4', absPath: '/videos/ep1/renders/ep1.mp4', check: null }
			}
		],
		task_take_notices: () => [],
		audio_save_in_folder: (a) => {
			bytes.set(a!.relPath as string, new Uint8Array([1]));
		},
		video_still_extract: (a) => {
			const req = a!.request as { out: string };
			bytes.set(req.out, new Uint8Array([2]));
			return { path: req.out, width: 1, height: 1, previewDataUrl: '' };
		},
		image_store_bytes: () => 'f'.repeat(64),
		video_episode_ensure: (a) => {
			const made = !dirs.has(a!.episode as string);
			dirs.add(a!.episode as string);
			return made;
		},
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
	cuts = [];
	dirs = new Set(['ep1']);
	music.made = [];
	bytes = new Map();
	image.requests = [];
	video.made = [];
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
		expect(h.steps[REPORT].output).toMatch(/^Wrote ep1\/REPORT-sequence.md/);
		expect(asked.questions).toEqual([]);
	});

	it('makes a missing episode folder before it looks in it, and says so', async () => {
		dirs.clear();
		const h = harness({ run_mode: 'unattended' }, () => foxArgs());
		await runVideoSequencePipeline(h.ctx);
		expect(h.finished?.status).toBe('succeeded');
		const calls = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
		expect(calls.indexOf('video_episode_ensure')).toBeLessThan(calls.indexOf('video_probe_folder'));
		expect(invoke).toHaveBeenCalledWith('video_episode_ensure', {
			workingDir: '/videos',
			episode: 'ep1'
		});
		expect(h.steps[INTERVIEW].output).toMatch(/^Made the episode folder ep1\. Skipped:/);
	});

	it('makes no folder when the working folder is the episode', async () => {
		const h = harness({ run_mode: 'unattended', episode_dir: '' }, () => foxArgs());
		await runVideoSequencePipeline(h.ctx);
		expect(h.finished?.status).toBe('succeeded');
		expect(invoke).not.toHaveBeenCalledWith('video_episode_ensure', expect.anything());
		expect(h.steps[INTERVIEW].output).toMatch(/^Skipped:/);
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
			{ kind: 'selected', labels: ['Approve'] },
			{ kind: 'selected', labels: ['Approve'] },
			{ kind: 'selected', labels: ['Continue'] },
			{ kind: 'selected', labels: ['Continue'] }
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
			{ kind: 'selected', labels: ['Approve'] },
			{ kind: 'selected', labels: ['Approve'] },
			{ kind: 'selected', labels: ['Continue'] },
			{ kind: 'selected', labels: ['Continue'] }
		];
		const h = harness({}, () => foxArgs());
		const plain = routes();
		vi.mocked(invoke).mockImplementation(
			invokeRouter(
				{
					fs_write_text: (a) => {
						const rel = a!.relPath as string;
						if (!rel.endsWith('sequence.json')) return void files.set(rel, a!.content as string);
						// The user's editor saves the forest at 45 s.
						const spec = JSON.parse(a!.content as string);
						spec.sections[1].seconds = 45;
						files.set(rel, JSON.stringify(spec));
					}
				},
				(cmd: string, args?: Record<string, unknown>) => plain(cmd, args)
			)
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

	it('makes the keyframes and records them, then a rerun makes none', async () => {
		const h = harness({ run_mode: 'unattended' }, () => foxArgs());
		await runVideoSequencePipeline(h.ctx);
		expect(h.finished?.status).toBe('succeeded');
		// Two keyframes and four re-anchors, all from the image backend.
		expect(image.requests).toHaveLength(6);
		expect(image.requests[1].edit).toBeTruthy();
		expect(bytes.has('ep1/keyframes/snow.png')).toBe(true);
		expect(bytes.has('ep1/keyframes/forest-r12.png')).toBe(true);
		const progress = JSON.parse(files.get('ep1/.haruspex/sequence-progress.json')!);
		expect(progress.keyframes.snow.status).toBe('done');
		expect(h.steps[KEYFRAMES].output).toContain(
			'- forest: keyframes/forest.png (an edit of the first keyframe)'
		);
		expect(h.steps[KEYFRAMES].output).toContain('![snow](haruspex-img://localhost/');
		const again = harness({ run_mode: 'unattended' }, () => {
			throw new Error('the spec is on disk');
		});
		await runVideoSequencePipeline(again.ctx);
		expect(image.requests).toHaveLength(6);
		expect(again.steps[KEYFRAMES].output).toContain('(kept from the last run)');
	});

	it('stops at the stills when attended, and redoes one asked for', async () => {
		asked.answers = [
			{ kind: 'selected', labels: ['Approve'] },
			{ kind: 'selected', labels: ['Redo one'] },
			{ kind: 'selected', labels: ['forest'], note: 'at dusk' },
			{ kind: 'selected', labels: ['Stop'] }
		];
		const h = harness({}, () => foxArgs());
		await runVideoSequencePipeline(h.ctx);
		expect(asked.questions[1].question).toBe('Every clip starts from these stills. Approve them?');
		expect(asked.questions[1].images?.map((i) => i.alt)).toEqual([
			'snow',
			'forest',
			'snow, clip 6',
			'snow, clip 12',
			'forest, clip 6',
			'forest, clip 12'
		]);
		expect(asked.questions[1].images?.[0].src).toMatch(/^haruspex-img:\/\/localhost\//);
		expect(asked.questions[2].options.map((o) => o.label)).toEqual(['snow', 'forest']);
		const redone = image.requests.slice(6);
		expect(redone).toHaveLength(3);
		expect(redone[0].prompt).toContain('at dusk');
		expect(h.finished).toEqual({ status: 'cancelled', error: null });
	});

	it('makes every clip into the episode folder, and a rerun makes none', async () => {
		const h = harness({ run_mode: 'unattended' }, () => foxArgs());
		await runVideoSequencePipeline(h.ctx);
		expect(h.finished?.error ?? null).toBeNull();
		expect(video.made).toHaveLength(25);
		expect(bytes.has('ep1/generated/snow-01.webm')).toBe(true);
		expect(bytes.has('ep1/generated/join-1.webm')).toBe(true);
		expect(h.steps[GENERATE].output).toMatch(
			/^25 clips made, 0 kept from before, in ep1\/generated/
		);
		const progress = JSON.parse(files.get('ep1/.haruspex/sequence-progress.json')!);
		expect(progress.clips['forest-12'].status).toBe('done');
		const again = harness({ run_mode: 'unattended' }, () => null);
		await runVideoSequencePipeline(again.ctx);
		expect(video.made).toHaveLength(25);
		expect(again.steps[GENERATE].output).toMatch(/^0 clips made, 25 kept/);
	});

	it('writes a note on a first clip into the spec and makes the section again', async () => {
		asked.answers = [
			{ kind: 'selected', labels: ['Approve'] },
			{ kind: 'selected', labels: ['Approve'] },
			{ kind: 'freeText', text: 'the fox walks slower' },
			{ kind: 'selected', labels: ['Continue'] },
			{ kind: 'selected', labels: ['Continue'] }
		];
		const h = harness({}, () => foxArgs());
		await runVideoSequencePipeline(h.ctx);
		expect(h.finished?.status).toBe('succeeded');
		const spec = JSON.parse(files.get('ep1/sequence.json')!);
		expect(spec.sections[0].prompt).toBe('a fox walking through deep snow. the fox walks slower');
		// The approved keyframe stays: its prompt is kept as the keyframe's.
		expect(spec.sections[0].keyframe_prompt).toBe('a fox walking through deep snow');
		expect(video.made.filter((t) => t === 'snow-01')).toHaveLength(2);
		expect(image.requests).toHaveLength(6);
	});

	it('makes the music, assembles the project, renders it and writes the report', async () => {
		const h = harness({ run_mode: 'unattended' }, () => foxArgs());
		await runVideoSequencePipeline(h.ctx);
		expect(h.finished).toEqual({ status: 'succeeded', error: null });
		// The piano bed under the whole ~2 minutes: one song.
		expect(music.made).toHaveLength(1);
		expect(bytes.has('ep1/music/piano.mp3')).toBe(true);
		const cut = cuts[0] as {
			items: unknown[];
			audio: { path: string; lufs: number }[];
			preset: string;
		};
		expect(cut.items).toHaveLength(25);
		expect(cut.preset).toBe('720p24');
		expect(cut.audio).toEqual([
			expect.objectContaining({ path: 'ep1/music/piano.mp3', lufs: -30 })
		]);
		expect(h.steps[ASSEMBLE].output).toMatch(/^Made ep1\/ep1.mlt: 25 clips, 720p24/);
		expect(h.steps[RENDER].output).toBe('Rendered ep1/renders/ep1.mp4.');
		const report = files.get('ep1/REPORT-sequence.md')!;
		expect(report).toContain('# Fox seasons');
		expect(report).toContain('The project is ep1/ep1.mlt.');
		const progress = JSON.parse(files.get('ep1/.haruspex/sequence-progress.json')!);
		expect(progress).toMatchObject({ project: 'ep1/ep1.mlt', render: 'ep1/renders/ep1.mp4' });
	});
});
