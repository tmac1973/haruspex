import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const runner = vi.hoisted(() => ({ runBuildModule: vi.fn() }));
vi.mock('#lib/helpers/three/runModule.ts', () => runner);

import { clip, pivotRig, turn } from './motionFixtures';
import { judgeModel } from './verdict';
import { modelFiles } from '#lib/models3d/spec/paths.ts';
import type { ModelEntry } from '#lib/models3d/spec/types.ts';

const files = new Map<string, string>();
const io = {
	read: async (path: string) => {
		const f = files.get(path);
		if (f === undefined) throw 'No such file';
		return [...new TextEncoder().encode(f)];
	},
	cwd: '/proj'
};

function entry(over: Partial<ModelEntry> = {}): ModelEntry {
	return {
		id: 'golem',
		title: 'Golem',
		description: 'a stone golem with one arm',
		height_m: 1,
		parts: ['Body', 'Shoulder', 'Arm'],
		clips: [{ name: 'Wave', seconds: 1, loop: true, action: 'waves its arm' }],
		dir: 'assets/generated/model/golem/',
		...over
	};
}

/** The arm swings up and back down, ending where it started. */
const wave = () => clip('Wave', 1, turn('Shoulder', [0, 0, 1], [0, 0.5, 1], [0, 40, 0]));

async function glbOf(animations: THREE.AnimationClip[] = []): Promise<Uint8Array> {
	const out = await new GLTFExporter().parseAsync(pivotRig(), { binary: true, animations });
	return new Uint8Array(out as ArrayBuffer);
}

async function builds(animations: THREE.AnimationClip[] = [], missing: string[] = []) {
	runner.runBuildModule.mockResolvedValue({
		glb: await glbOf(animations),
		errors: [],
		missingTracks: missing
	});
}

const golem = entry();
const paths = modelFiles(golem);

beforeEach(() => {
	// jsdom has no WebGL: the sheet can't draw, and says so.
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	files.clear();
	files.set(`/proj/${paths.build}`, 'export default (THREE) => new THREE.Group();');
	files.set(`/proj/${paths.anim}`, 'export default () => [];');
	runner.runBuildModule.mockReset();
});

describe('judgeModel', () => {
	it('passes a model that matches its entry, with the text check_3d would give', async () => {
		await builds();
		const v = await judgeModel({ entry: golem, files: paths, stage: 'create', io });
		expect(v.problems).toEqual([]);
		expect(v.done).toBe(true);
		expect(v.glb).not.toBeNull();
		expect(v.text.split('\n')[0]).toBe(`Wrote ${paths.glb}.`);
		expect(v.text).toContain('Size:');
		expect(v.clipSheets).toEqual({});
		// The create stage runs no animation module.
		expect(runner.runBuildModule.mock.calls[0][1].anim).toBeUndefined();
	});

	it('fails a model too far from the spec height', async () => {
		await builds();
		const v = await judgeModel({
			entry: entry({ height_m: 2 }),
			files: paths,
			stage: 'create',
			io
		});
		expect(v.done).toBe(false);
		expect(v.problems).toEqual(['Height is 1 m; the spec says 2 m (±10%).']);
	});

	it('fails a model missing a named part, pivots included', async () => {
		await builds();
		const v = await judgeModel({
			entry: entry({ parts: ['Body', 'Shoulder', 'Hip'] }),
			files: paths,
			stage: 'create',
			io
		});
		expect(v.problems).toEqual(['Missing part "Hip": name the pivot exactly so.']);
	});

	it('fails the animate stage on a missing clip and dropped tracks', async () => {
		await builds([wave()], ['Tail.quaternion']);
		const v = await judgeModel({
			entry: entry({
				clips: [
					{ name: 'Wave', seconds: 1, loop: true, action: 'waves' },
					{ name: 'Walk', seconds: 1, loop: true, action: 'walks' }
				]
			}),
			files: paths,
			stage: 'animate',
			io
		});
		expect(runner.runBuildModule.mock.calls[0][1].anim).toBe('export default () => [];');
		expect(v.done).toBe(false);
		expect(v.problems).toContain('Missing clip "Walk".');
		expect(v.problems).toContain("Tracks name nodes the model doesn't have: Tail.quaternion.");
		expect(v.text).toContain('Tracks naming a node the model doesn');
	});

	it('passes a clean clip, and fails a looping one that does not close', async () => {
		await builds([wave()]);
		const ok = await judgeModel({ entry: golem, files: paths, stage: 'animate', io });
		expect(ok.problems).toEqual([]);
		expect(ok.done).toBe(true);

		await builds([clip('Wave', 1, turn('Shoulder', [0, 0, 1], [0, 1], [0, 60]))]);
		const open = await judgeModel({ entry: golem, files: paths, stage: 'animate', io });
		expect(open.problems.some((p) => p.startsWith('Clip "Wave": loops but ends'))).toBe(true);

		// The same clip as a one-shot needs no seam, but it should end at rest.
		const once = entry({ clips: [{ name: 'Wave', seconds: 1, loop: false, action: 'waves' }] });
		const shot = await judgeModel({ entry: once, files: paths, stage: 'animate', io });
		expect(shot.problems).toEqual([
			'Clip "Wave": ends 25 cm from the rest pose (Arm): a one-shot starts and ends at the rest pose, so the game can blend into and out of it.'
		]);
	});

	it('is not done while the glTF validator finds errors', async () => {
		const rig = pivotRig();
		const body = rig.getObjectByName('Body') as THREE.Mesh;
		const n = body.geometry.attributes.position.count;
		body.geometry.setAttribute(
			'color',
			new THREE.BufferAttribute(new Float32Array(n * 3).fill(2), 3)
		);
		const out = await new GLTFExporter().parseAsync(rig, { binary: true });
		runner.runBuildModule.mockResolvedValue({
			glb: new Uint8Array(out as ArrayBuffer),
			errors: [],
			missingTracks: [],
			clamped: null
		});
		const v = await judgeModel({ entry: golem, files: paths, stage: 'create', io });
		expect(v.done).toBe(false);
		expect(v.problems).toEqual([
			'glTF validation: Vertex colour values outside 0–1 ×72 in Body: keep colours within 0–1.'
		]);
	});

	it('says when the runner clamped colours, without holding the model back', async () => {
		runner.runBuildModule.mockResolvedValue({
			glb: await glbOf(),
			errors: [],
			missingTracks: [],
			clamped: { count: 40, meshes: ['Body'] }
		});
		const v = await judgeModel({ entry: golem, files: paths, stage: 'create', io });
		expect(v.done).toBe(true);
		expect(v.text).toContain(
			'40 vertex colours outside 0–1 in Body were clamped (glTF allows only 0–1): keep shading within 0–1.'
		);
	});

	it('reports a module that failed to build as problems, with no GLB', async () => {
		runner.runBuildModule.mockResolvedValue({
			glb: null,
			errors: [{ kind: 'error', message: 'boom', line: 3, file: 'build' }],
			missingTracks: []
		});
		const v = await judgeModel({ entry: golem, files: paths, stage: 'create', io });
		expect(v).toMatchObject({ done: false, problems: ['line 3: boom'], glb: null });
		expect(v.text).toBe(
			['The check failed.', '- line 3: boom', `Fix ${paths.build} and call check_3d again.`].join(
				'\n'
			)
		);
	});

	it('reports a file it could not read', async () => {
		files.clear();
		const v = await judgeModel({ entry: golem, files: paths, stage: 'create', io });
		expect(v.done).toBe(false);
		expect(v.problems[0]).toMatch(/^Could not read assets\/generated\/model\/golem\/golem\.js/);
		expect(runner.runBuildModule).not.toHaveBeenCalled();
	});
});
