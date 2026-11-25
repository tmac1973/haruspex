import { beforeEach, describe, expect, it, vi } from 'vitest';

const runner = vi.hoisted(() => ({ runBuildModule: vi.fn() }));
vi.mock('#lib/helpers/three/runModule.ts', () => runner);
const glb = vi.hoisted(() => ({ checkGlb: vi.fn() }));
vi.mock('#lib/glb/check.ts', () => glb);

import { runCheck3d, type Check3dHost } from './call';

const GLB = new Uint8Array([1, 2, 3]);
const enc = (s: string) => [...new TextEncoder().encode(s)];

function fakeHost(files: Map<string, number[]>): Check3dHost {
	return {
		read: async (path) => {
			const f = files.get(path);
			if (!f) throw 'No such file';
			return f;
		},
		write: async (path, bytes) => {
			files.set(path, [...bytes]);
			return null;
		},
		cwd: '/proj',
		runFrame: async () => {},
		attachSheet: () => false
	};
}

const clean = {
	bytes: GLB,
	report: {},
	text: 'Size: 1 m',
	png: 'png',
	invalid: [],
	clipProblems: []
};

let files: Map<string, number[]>;
beforeEach(() => {
	files = new Map([['/proj/a.js', enc('export default (T) => new T.Group();')]]);
	runner.runBuildModule.mockReset().mockResolvedValue({ glb: GLB, errors: [], missingTracks: [] });
	glb.checkGlb.mockReset().mockResolvedValue(clean);
});

describe('runCheck3d’s ok', () => {
	it('is true for a clean check', async () => {
		const reply = await runCheck3d({ path: 'a.js' }, fakeHost(files));
		expect(reply).toMatchObject({ ok: true, problems: [], png: 'png' });
		expect(files.get('/proj/a.glb')).toEqual([...GLB]);
	});

	it('is false when the module throws, with its line', async () => {
		runner.runBuildModule.mockResolvedValue({
			glb: null,
			errors: [{ kind: 'error', message: 'x is not defined', line: 3, file: 'build' }],
			missingTracks: []
		});
		const reply = await runCheck3d({ path: 'a.js' }, fakeHost(files));
		expect(reply).toMatchObject({ ok: false, problems: ['- line 3: x is not defined'] });
	});

	it('is false when the GLB check fails', async () => {
		glb.checkGlb.mockResolvedValue({ problems: ['The GLB has no meshes.'] });
		const reply = await runCheck3d({ path: 'a.js' }, fakeHost(files));
		expect(reply).toMatchObject({ ok: false, problems: ['- The GLB has no meshes.'] });
	});

	it('is false for validator lines, clip problems and dropped tracks', async () => {
		glb.checkGlb.mockResolvedValue({
			...clean,
			invalid: ['- ACCESSOR_MAX_MISMATCH (2): in Body'],
			clipProblems: ['Clip "Walk": off the floor by 4 cm at 0.5 s.']
		});
		runner.runBuildModule.mockResolvedValue({ glb: GLB, errors: [], missingTracks: ['Tail'] });
		const reply = await runCheck3d({ path: 'a.js' }, fakeHost(files));
		if ('error' in reply) throw new Error(reply.error);
		expect(reply.ok).toBe(false);
		expect(reply.problems).toHaveLength(3);
		expect(reply.problems[2]).toBe('- Clip "Walk": off the floor by 4 cm at 0.5 s.');
	});
});
