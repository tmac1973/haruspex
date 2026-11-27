import { describe, it, expect, beforeEach } from 'vitest';
import { makeKeyframes, stillPath, stillsSummary, type KeyframeDeps } from './keyframes';
import { planClips } from '#lib/sequence/spec/plan.ts';
import { stillKeys } from '#lib/sequence/spec/progress.ts';
import { LTX_MODEL, foxSpec, presenterSpec } from '#lib/testing/sequenceSpecs.ts';
import type { ImageRequest } from '#lib/image/types.ts';
import type { FileProgress } from '#lib/sequence/spec/progress.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';

let disk: Map<string, Uint8Array>;
let requests: ImageRequest[];
let fitted: Array<[number, number]>;
let firstFrames: Array<[string, number, string]>;

function deps(over: Partial<KeyframeDeps> = {}): KeyframeDeps {
	return {
		draws: true,
		canEdit: true,
		generate: async (req) => {
			requests.push(req);
			return {
				images: [
					{ bytes: new Uint8Array([requests.length]), mimeType: 'image/png', width: 1, height: 1 }
				],
				meta: {} as never
			};
		},
		fit: async (bytes, w, h) => {
			fitted.push([w, h]);
			return bytes;
		},
		write: async (rel, bytes) => void disk.set(rel, bytes),
		read: async (rel) => disk.get(rel) ?? null,
		exists: async (rel) => disk.has(rel),
		firstFrame: async (clip, at, out) => {
			firstFrames.push([clip, at, out]);
			disk.set(out, new Uint8Array([9]));
		},
		...over,
		keyframes: over.keyframes ?? over.draws ?? true
	};
}

function runOf(spec: SequenceSpec, done: Record<string, FileProgress> = {}, keyframes = true) {
	const plan = planClips(spec, LTX_MODEL, keyframes);
	return { spec, plan, keys: stillKeys(spec, plan), done };
}

beforeEach(() => {
	disk = new Map();
	requests = [];
	fitted = [];
	firstFrames = [];
});

describe('makeKeyframes', () => {
	it('draws the first section and edits the second from it, then the re-anchors', async () => {
		const run = runOf(foxSpec());
		const stills = await makeKeyframes(run, deps());
		expect(stills.map((s) => [s.id, s.how])).toEqual([
			['snow', 'drawn'],
			['forest', 'edited'],
			['snow-r6', 'edited'],
			['snow-r12', 'edited'],
			['forest-r6', 'edited'],
			['forest-r12', 'edited']
		]);
		expect(requests[0].edit).toBeUndefined();
		expect(requests[0].prompt).toBe(
			'a fox walking through deep snow. a red fox, natural light, documentary look'
		);
		expect(requests[1].prompt).toMatch(
			/^The same subject as in the picture, now: a fox in a sunny/
		);
		// The edit starts from the snow keyframe as it was saved.
		expect(requests[1].edit?.images[0]).toEqual({ name: 'snow.png', bytes: [1] });
		expect([requests[0].width, requests[0].height]).toEqual([1280, 704]);
		expect(fitted.every(([w, h]) => w === 1280 && h === 704)).toBe(true);
		expect(disk.has(stillPath('forest'))).toBe(true);
		expect(run.done.forest).toMatchObject({ status: 'done', key: run.keys.forest });
		expect(run.done['snow-r6'].status).toBe('done');
	});

	it('draws every section, and reuses keyframes as re-anchors, without editing', async () => {
		const stills = await makeKeyframes(runOf(foxSpec()), deps({ canEdit: false }));
		expect(stills.filter((s) => !s.n).map((s) => s.how)).toEqual(['drawn', 'drawn']);
		expect(requests.every((r) => !r.edit)).toBe(true);
		expect(requests).toHaveLength(2);
		const r6 = stills.find((s) => s.id === 'snow-r6')!;
		expect(r6).toMatchObject({ how: 'reused', file: stillPath('snow') });
	});

	it('makes nothing without an image backend: sections open from their prompts', async () => {
		const run = runOf(foxSpec(), {}, false);
		const stills = await makeKeyframes(run, deps({ draws: false, canEdit: false }));
		expect(stills).toEqual([]);
		expect(requests).toEqual([]);
		const first = run.plan.items[0];
		expect(first.kind === 'generate' && first.start).toEqual({ kind: 'text' });
		expect(stillsSummary(stills)).toMatch(/opens from its prompt alone/);
	});

	it('draws only portraits when sections start from their prompts', async () => {
		const spec = presenterSpec();
		const run = runOf(spec, {}, false);
		const stills = await makeKeyframes(run, deps({ keyframes: false }));
		expect(stills.map((s) => [s.id, s.how])).toEqual([['host', 'drawn']]);
		expect(requests).toHaveLength(1);
		expect(requests[0].prompt).toMatch(/^Portrait of/);
	});

	it('uses the user’s start picture as it is', async () => {
		const spec = foxSpec();
		(spec.sections[0] as { start_image?: string }).start_image = 'stills/fox.png';
		const stills = await makeKeyframes(runOf(spec), deps());
		expect(stills[0]).toEqual({ id: 'snow', section: 'snow', file: 'stills/fox.png', how: 'user' });
		// Nothing to edit from in the cache: the forest is drawn.
		expect(stills[1]).toMatchObject({ id: 'forest', how: 'drawn' });
		expect(stills.find((s) => s.id === 'snow-r6')).toMatchObject({
			how: 'reused',
			file: 'stills/fox.png'
		});
	});

	it('skips stills a rerun finds done and on disk, and remakes one asked for', async () => {
		const run = runOf(foxSpec());
		await makeKeyframes(run, deps());
		const made = requests.length;
		const again = await makeKeyframes({ ...run }, deps());
		expect(requests).toHaveLength(made);
		expect(again.every((s) => s.how === 'kept')).toBe(true);
		// A changed key, or a file gone from disk, is made again.
		disk.delete(stillPath('forest'));
		await makeKeyframes(run, deps());
		expect(requests).toHaveLength(made + 1);
		// Redo the forest with a note: it and its re-anchors.
		const redo = await makeKeyframes(
			{ ...run, redo: { section: 'forest', note: 'at dusk' } },
			deps()
		);
		expect(redo.filter((s) => s.how === 'edited').map((s) => s.id)).toEqual([
			'forest',
			'forest-r6',
			'forest-r12'
		]);
		expect(requests[made + 1].prompt).toContain('at dusk');
	});

	it('takes the first frame of an existing clip a transition ends on', async () => {
		const spec: SequenceSpec = {
			...foxSpec(),
			sections: [
				{ kind: 'generated', id: 'snow', prompt: 'snow', seconds: 4 },
				{ kind: 'existing', id: 'phone', path: 'raw/phone.mp4', in_secs: 2 }
			],
			reanchor_every: 0
		};
		spec.sound.music = [];
		const stills = await makeKeyframes(runOf(spec), deps());
		expect(firstFrames).toEqual([['raw/phone.mp4', 2, stillPath('phone-first')]]);
		expect(stills.map((s) => [s.id, s.how])).toEqual([
			['snow', 'drawn'],
			['phone-first', 'first-frame']
		]);
	});
});
