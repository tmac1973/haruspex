import { beforeEach, describe, expect, it, vi } from 'vitest';

const runner = vi.hoisted(() => ({ runBuildModule: vi.fn() }));
vi.mock('#lib/helpers/three/runModule.ts', () => runner);
const glb = vi.hoisted(() => ({ checkGlb: vi.fn() }));
vi.mock('#lib/glb/check.ts', () => glb);

import type { Check3dHost } from './call';
import { finalCheck3d, MODULE_NEVER_WRITTEN } from './delegateCheck';

const GLB = new Uint8Array([1, 2, 3]);
const enc = (s: string) => [...new TextEncoder().encode(s)];
const paths = {
	module: 'assets/crate.js',
	anim: 'assets/crate.anim.js',
	glb: 'assets/crate.glb'
};

let files: Map<string, number[]>;
const host = (): Check3dHost => ({
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
});

beforeEach(() => {
	files = new Map();
	runner.runBuildModule.mockReset().mockResolvedValue({ glb: GLB, errors: [], missingTracks: [] });
	glb.checkGlb.mockReset().mockResolvedValue({
		bytes: GLB,
		report: { animations: [] },
		text: 'Size: 1 m',
		png: 'data:image/png;base64,AA',
		invalid: [],
		clipProblems: []
	});
});

describe('finalCheck3d', () => {
	it('passes a clean module, writes the GLB and returns the sheet', async () => {
		files.set('/proj/assets/crate.js', enc('export default (T) => new T.Group();'));
		const res = await finalCheck3d(paths, host());
		expect(res).toMatchObject({ ok: true, problems: [], png: 'data:image/png;base64,AA' });
		expect(res.text).toContain('Wrote assets/crate.glb.');
		expect(files.get('/proj/assets/crate.glb')).toEqual([...GLB]);
		expect(runner.runBuildModule.mock.calls[0][1].anim).toBeUndefined();
	});

	it('runs the anim module when it exists', async () => {
		files.set('/proj/assets/crate.js', enc('build'));
		files.set('/proj/assets/crate.anim.js', enc('anim'));
		await finalCheck3d(paths, host());
		expect(runner.runBuildModule.mock.calls[0][1].anim).toBe('anim');
	});

	it('fails a module that throws, with its line', async () => {
		files.set('/proj/assets/crate.js', enc('build'));
		runner.runBuildModule.mockResolvedValue({
			glb: null,
			errors: [{ kind: 'error', message: 'boom', line: 7, file: 'build' }],
			missingTracks: []
		});
		const res = await finalCheck3d(paths, host());
		expect(res.ok).toBe(false);
		expect(res.problems).toEqual(['- line 7: boom']);
		expect(res.text).toContain('- line 7: boom');
	});

	it('says when the module was never written', async () => {
		const res = await finalCheck3d(paths, host());
		expect(res).toEqual({
			ok: false,
			text: MODULE_NEVER_WRITTEN,
			problems: [`- ${MODULE_NEVER_WRITTEN}`]
		});
		expect(MODULE_NEVER_WRITTEN).toBe('The module was never written.');
		expect(runner.runBuildModule).not.toHaveBeenCalled();
	});
});
