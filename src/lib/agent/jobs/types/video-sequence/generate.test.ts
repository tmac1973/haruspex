import { describe, it, expect, beforeEach } from 'vitest';
import { clipPath, makeOrder, runGenerate, type GenerateDeps, type GenerateRun } from './generate';
import { planClips } from '#lib/sequence/spec/plan.ts';
import { itemKeys, type ClipProgress } from '#lib/sequence/spec/progress.ts';
import { LTX, foxSpec } from '#lib/testing/sequenceSpecs.ts';
import type { VideoRequest, VideoResult } from '#lib/videogen/types.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';

let requests: VideoRequest[];
let resumed: string[];
let stills: Array<[string, string, string | number]>;
let saved: string[];
let disk: Set<string>;
let failures: number;
let clock: number;

const result = (req: VideoRequest): VideoResult => ({
	hash: req.title.padEnd(64, '0').slice(0, 64),
	url: '',
	mime: 'video/webm',
	width: req.width,
	height: req.height,
	frames: req.frames,
	fps: req.fps,
	seed: req.seed,
	model: 'ltx',
	hasAudio: true
});

function deps(over: Partial<GenerateDeps> = {}): GenerateDeps {
	return {
		generate: async (req, opts) => {
			opts.onHandle?.({
				backend: 'llama-toolchest',
				baseUrl: 'b',
				id: `job-${req.title}`,
				model: 'ltx',
				keyId: ''
			});
			if (failures > 0) {
				failures--;
				throw new Error('out of memory');
			}
			requests.push(req);
			clock += 240_000;
			return result(req);
		},
		resume: async (handle, req) => {
			resumed.push(handle.id);
			return result(req);
		},
		cacheImage: async (rel) => ({ name: rel, hash: `hash:${rel}` }),
		still: async (clip, out, at) => {
			stills.push([clip, out, at]);
		},
		saveClip: async (_hash, rel) => {
			saved.push(rel);
			disk.add(rel);
		},
		exists: async (rel) => disk.has(rel),
		saveProgress: async () => {},
		status: () => {},
		seed: () => 4242,
		now: () => clock,
		...over
	};
}

function runOf(spec: SequenceSpec, clips: Record<string, ClipProgress> = {}): GenerateRun {
	const plan = planClips(spec, LTX, true);
	return {
		plan,
		keys: itemKeys(spec, plan),
		clips,
		stills: {
			snow: 'keyframes/snow.png',
			forest: 'keyframes/forest.png',
			'snow-r2': 'keyframes/snow-r2.png',
			'snow-r6': 'keyframes/snow-r6.png',
			'snow-r12': 'keyframes/snow-r12.png',
			'forest-r6': 'keyframes/forest-r6.png',
			'forest-r12': 'keyframes/forest-r12.png'
		}
	};
}

/** The fox spec, short: two clips of snow, a transition, one of forest. */
function shortFox(): SequenceSpec {
	const spec = foxSpec();
	(spec.sections[0] as { seconds: number }).seconds = 10;
	(spec.sections[1] as { seconds: number }).seconds = 5;
	spec.reanchor_every = 2;
	return spec;
}

beforeEach(() => {
	requests = [];
	resumed = [];
	stills = [];
	saved = [];
	disk = new Set();
	failures = 0;
	clock = 0;
});

describe('runGenerate', () => {
	it('chains each clip from the last frame of the one before, with end pictures', async () => {
		const run = runOf(shortFox());
		const out = await runGenerate(run, deps());
		expect(out).toMatchObject({ kind: 'done', made: 4, kept: 0, secsPerClip: 240 });
		expect(requests.map((r) => r.title)).toEqual(['snow-01', 'snow-02', 'join-1', 'forest-01']);
		const [a, b, join, forest] = requests;
		expect(a.startImage?.name).toBe('keyframes/snow.png');
		expect(a.endImage).toBeUndefined();
		// The continuation starts from snow-01's true last frame, and re-anchors.
		expect(stills[0]).toEqual([clipPath('snow-01'), '.haruspex/stills/snow-01-last.png', 'last']);
		expect(b.startImage?.name).toBe('.haruspex/stills/snow-01-last.png');
		expect(b.endImage?.name).toBe('keyframes/snow-r2.png');
		// The transition runs from snow's last frame to the forest keyframe.
		expect(join.startImage?.name).toBe('.haruspex/stills/snow-02-last.png');
		expect(join.endImage?.name).toBe('keyframes/forest.png');
		expect(forest.startImage?.name).toBe('keyframes/forest.png');
		expect([a.width, a.height, a.fps, a.frames]).toEqual([1280, 704, 24, 121]);
		expect(saved).toEqual([
			'generated/snow-01.webm',
			'generated/snow-02.webm',
			'generated/join-1.webm',
			'generated/forest-01.webm'
		]);
		expect(run.clips['snow-02']).toMatchObject({
			status: 'done',
			hasAudio: true,
			seed: 4242,
			secs: 240
		});
	});

	it('starts at the first clip not made', async () => {
		const run = runOf(foxSpec());
		await runGenerate(run, deps());
		const made = requests.length;
		// Five done and on disk; the rest gone.
		const order = makeOrder(run.plan).map((i) => i.id);
		for (const id of order.slice(5)) delete run.clips[id];
		requests = [];
		const out = await runGenerate(run, deps());
		expect(out).toMatchObject({ made: made - 5, kept: 5 });
		expect(requests[0].title).toBe(order[5]);
	});

	it('follows a job that was in flight instead of starting it again', async () => {
		const spec = shortFox();
		const first = runOf(spec);
		const clips: Record<string, ClipProgress> = {
			'snow-01': { key: first.keys['snow-01'], status: 'done', file: clipPath('snow-01'), seed: 1 },
			'snow-02': {
				key: first.keys['snow-02'],
				status: 'running',
				seed: 9,
				handle: { backend: 'llama-toolchest', baseUrl: 'b', id: 'job-77', model: 'ltx', keyId: '' }
			}
		};
		disk.add(clipPath('snow-01'));
		await runGenerate({ ...first, clips }, deps());
		expect(resumed).toEqual(['job-77']);
		expect(requests.map((r) => r.title)).toEqual(['join-1', 'forest-01']);
		expect(clips['snow-02']).toMatchObject({ status: 'done', seed: 9 });
	});

	it('makes a clip again when the server no longer has its job', async () => {
		const first = runOf(shortFox());
		const clips: Record<string, ClipProgress> = {
			'snow-01': {
				key: first.keys['snow-01'],
				status: 'running',
				seed: 9,
				handle: { backend: 'llama-toolchest', baseUrl: 'b', id: 'gone', model: 'ltx', keyId: '' }
			}
		};
		await runGenerate(
			{ ...first, clips },
			deps({
				resume: async () => {
					throw new Error('not found');
				}
			})
		);
		expect(requests[0]).toMatchObject({ title: 'snow-01', seed: 9 });
	});

	it('retries a failed clip once on a new seed, then fails naming it', async () => {
		failures = 1;
		const run = runOf(shortFox());
		await runGenerate(run, deps({ seed: () => 77 }));
		expect(requests[0]).toMatchObject({ title: 'snow-01', seed: 77 });
		failures = 2;
		const again = runOf(shortFox());
		await expect(runGenerate(again, deps())).rejects.toThrow(
			'Clip snow-01 failed twice: out of memory'
		);
		expect(again.clips['snow-01'].status).toBe('failed');
	});

	it('asks after each section’s first clip, and redoes it on a new seed', async () => {
		const asked: string[] = [];
		const answers: Array<'continue' | 'stop' | { redo: string }> = [
			{ redo: '' },
			'continue',
			'continue'
		];
		let seeds = 0;
		await runGenerate(
			runOf(shortFox()),
			deps({
				seed: () => 100 + seeds++,
				ask: async (item) => {
					asked.push(item.id);
					return answers.shift()!;
				}
			})
		);
		expect(asked).toEqual(['snow-01', 'snow-01', 'forest-01']);
		expect(requests.map((r) => [r.title, r.seed])).toEqual([
			['snow-01', 100],
			['snow-01', 101],
			['snow-02', 102],
			['join-1', 103],
			['forest-01', 104]
		]);
	});

	it('hands a redo with a note back to the caller, and stops when asked', async () => {
		const run = runOf(shortFox());
		const redo = await runGenerate(run, deps({ ask: async () => ({ redo: 'slower' }) }));
		expect(redo).toEqual({ kind: 'redo', section: 'snow', note: 'slower' });
		await expect(runGenerate(runOf(shortFox()), deps({ ask: async () => 'stop' }))).rejects.toThrow(
			'Aborted'
		);
	});

	it('makes a transition that ends on a clip made from text after that clip', () => {
		const spec = shortFox();
		const plan = planClips(spec, LTX, false);
		expect(makeOrder(plan).map((i) => i.id)).toEqual(['snow-01', 'snow-02', 'forest-01', 'join-1']);
	});

	it('stops at once on a missing picture, without spending a retry on the model', async () => {
		const run = runOf(shortFox());
		await expect(
			runGenerate(
				run,
				deps({
					cacheImage: async () => {
						throw new Error('keyframes/snow.png is missing.');
					}
				})
			)
		).rejects.toThrow('keyframes/snow.png is missing.');
		expect(requests).toEqual([]);
	});
});
