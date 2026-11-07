import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => new Map<string, number[]>());
const io = vi.hoisted(() => ({
	read: vi.fn(async (path: string) => {
		const f = files.get(path);
		if (!f) throw 'No such file';
		return f;
	}),
	write: vi.fn(async (path: string, bytes: number[], _overwrite: boolean, dryRun: boolean) => {
		if (!dryRun) files.set(path, bytes);
	})
}));
vi.mock('#lib/agent/tools/_assetIo.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/agent/tools/_assetIo.ts')>()),
	assetIo: () => io
}));
const runner = vi.hoisted(() => ({ runBuildModule: vi.fn() }));
vi.mock('#lib/helpers/three/runModule.ts', () => runner);
const glb = vi.hoisted(() => ({ checkGlb: vi.fn() }));
vi.mock('#lib/glb/check.ts', () => glb);

import { executeTool } from '#lib/agent/tools/index.ts';
import { TOOL_FAMILIES } from '#lib/agent/tools/_families.ts';
import { toolCategory } from '#lib/agent/tools/registry.ts';
import { MOTION_NOTE, SHEET_NOTE } from './check-3d';
import { closeUpNote } from '#lib/helpers/three/load.ts';

const GLB = new Uint8Array([103, 108, 84, 70]);
const NORMALISED = new Uint8Array([9, 9]);
const PNG = 'data:image/png;base64,AA';
const MODULE = 'export default (THREE) => new THREE.Group();';
const enc = (s: string) => [...new TextEncoder().encode(s)];

function ctx(over: Record<string, unknown> = {}) {
	return {
		workingDir: '/proj',
		codeMode: true,
		visionSupported: true,
		pendingImages: [] as { path: string; dataUrl: string }[],
		onProgress: vi.fn(),
		...over
	};
}

function call(args: Record<string, unknown>, c = ctx()) {
	return executeTool('check_3d', args, c as never);
}

beforeEach(() => {
	files.clear();
	io.write.mockClear();
	runner.runBuildModule.mockReset().mockResolvedValue({ glb: GLB, errors: [], missingTracks: [] });
	glb.checkGlb
		.mockReset()
		.mockResolvedValue({ bytes: GLB, report: {}, text: 'Size: 1 m', png: PNG });
});

describe('check_3d', () => {
	it('builds a module, writes its GLB beside it and attaches the sheet', async () => {
		files.set('/proj/assets/crate.js', enc(MODULE));
		const c = ctx();
		const out = await call({ path: 'assets/crate.js' }, c);
		expect(runner.runBuildModule.mock.calls[0][0]).toBe(MODULE);
		expect(files.get('/proj/assets/crate.glb')).toEqual([...GLB]);
		expect(out.result).toBe(['Wrote assets/crate.glb.', 'Size: 1 m', SHEET_NOTE].join('\n'));
		expect(out.thumbDataUrl).toBe(PNG);
		expect(c.pendingImages).toEqual([{ path: 'assets/crate.glb', dataUrl: PNG }]);
	});

	it('points at an animation module beside the build module when it was not passed', async () => {
		files.set('/proj/models/bear/bear.js', enc(MODULE));
		files.set('/proj/models/bear/bear.anim.js', enc('export default () => [];'));
		const still = { bytes: GLB, report: { animations: [] }, text: 'No animation.', png: PNG };
		glb.checkGlb.mockResolvedValue(still);
		const hint =
			'models/bear/bear.anim.js was not passed: add anim: "models/bear/bear.anim.js" to check its clips.';

		expect((await call({ path: 'models/bear/bear.js', spec_height: 1.2 })).result).toContain(hint);
		// Passed, it is no news; with no module beside it there is nothing to point at.
		const passed = await call({ path: 'models/bear/bear.js', anim: 'models/bear/bear.anim.js' });
		expect(passed.result).not.toContain('was not passed');
		files.delete('/proj/models/bear/bear.anim.js');
		expect((await call({ path: 'models/bear/bear.js' })).result).not.toContain('was not passed');
	});

	it('finds an animation module named with _anim or -anim too', async () => {
		files.set('/proj/m/hero.js', enc(MODULE));
		files.set('/proj/m/hero_anim.js', enc('export default () => [];'));
		glb.checkGlb.mockResolvedValue({ bytes: GLB, report: { animations: [] }, text: '', png: PNG });
		expect((await call({ path: 'm/hero.js' })).result).toContain(
			'm/hero_anim.js was not passed: add anim: "m/hero_anim.js"'
		);
	});

	it('takes anim and clip together with out, ground and spec_height', async () => {
		// The 2026-11-04 reports: the five arguments together read as if anim and clip were dropped.
		files.set('/proj/m/bear.js', enc(MODULE));
		files.set('/proj/m/bear.anim.js', enc('export default () => [];'));
		await call({
			path: 'm/bear.js',
			out: 'm/bear.glb',
			ground: true,
			spec_height: 1.2,
			anim: 'm/bear.anim.js',
			clip: 'Walk'
		});
		expect(runner.runBuildModule.mock.calls[0][1]).toMatchObject({
			anim: 'export default () => [];'
		});
		expect(glb.checkGlb.mock.calls[0][1]).toMatchObject({
			clip: 'Walk',
			ground: true,
			specHeight: 1.2
		});
	});

	it('says which vertex colours the runner clamped', async () => {
		files.set('/proj/assets/crate.js', enc(MODULE));
		runner.runBuildModule.mockResolvedValueOnce({
			glb: GLB,
			errors: [],
			missingTracks: [],
			clamped: { count: 7, meshes: ['Lid', 'Plank_1', 'Plank_2', 'Plank_3', 'Plank_4', 'Base'] }
		});
		const out = await call({ path: 'assets/crate.js' });
		expect(out.result).toContain(
			'7 vertex colours outside 0–1 in Lid, Plank_1, Plank_2, Plank_3 and 2 more were clamped (glTF allows only 0–1): keep shading within 0–1.'
		);
	});

	it('passes normalisation and the budget through, and writes what it returns', async () => {
		files.set('/proj/a.js', enc(MODULE));
		glb.checkGlb.mockResolvedValueOnce({
			bytes: NORMALISED,
			report: {},
			text: 'Size: 1 m. Normalised from 2 m.',
			png: PNG,
			normalisedFrom: {}
		});
		await call({ path: 'a.js', out: 'b.glb', height: 1.8, ground: true, max_triangles: 500 });
		expect(glb.checkGlb.mock.calls[0][1]).toEqual({
			height: 1.8,
			ground: true,
			maxTriangles: 500,
			clip: undefined,
			view: undefined,
			specHeight: undefined
		});
		expect(files.get('/proj/b.glb')).toEqual([...NORMALISED]);
	});

	it('reports module errors with their lines and writes nothing', async () => {
		files.set('/proj/a.js', enc(MODULE));
		runner.runBuildModule.mockResolvedValueOnce({
			glb: null,
			errors: [
				{ kind: 'error', message: "Unexpected token ';'", line: 7 },
				{ kind: 'timeout', message: 'Timed out', line: null }
			]
		});
		const out = await call({ path: 'a.js' });
		expect(out.result).toBe(
			[
				'The check failed.',
				"- line 7: Unexpected token ';'",
				'- Timed out',
				'Fix a.js and call check_3d again.'
			].join('\n')
		);
		expect(glb.checkGlb).not.toHaveBeenCalled();
		expect(io.write).not.toHaveBeenCalled();
	});

	it('fails on what the GLB check finds', async () => {
		files.set('/proj/a.js', enc(MODULE));
		glb.checkGlb.mockResolvedValueOnce({ problems: ['The GLB has no meshes.'] });
		const out = await call({ path: 'a.js' });
		expect(out.result).toContain('- The GLB has no meshes.');
		expect(io.write).not.toHaveBeenCalled();
	});

	it('checks a .glb as it is, writing nothing', async () => {
		files.set('/proj/blender.glb', [...GLB]);
		const out = await call({ path: 'blender.glb' });
		expect(runner.runBuildModule).not.toHaveBeenCalled();
		expect(glb.checkGlb.mock.calls[0][0]).toEqual(GLB);
		expect(out.result).toMatch(/^Checked blender\.glb \(nothing written\)\./);
		expect(io.write).not.toHaveBeenCalled();
	});

	it('writes a normalised .glb only to out, never over the original', async () => {
		files.set('/proj/blender.glb', [...GLB]);
		expect((await call({ path: 'blender.glb', height: 2 })).result).toMatch(/Pass out/);
		expect((await call({ path: 'blender.glb', ground: true, out: 'blender.glb' })).result).toMatch(
			/out must not be the file/
		);
		glb.checkGlb.mockResolvedValueOnce({
			bytes: NORMALISED,
			report: {},
			text: 'x',
			png: null,
			normalisedFrom: {}
		});
		const out = await call({ path: 'blender.glb', height: 2, out: 'blender_2m.glb' });
		expect(out.result).toMatch(/^Wrote blender_2m\.glb\./);
		expect(files.get('/proj/blender_2m.glb')).toEqual([...NORMALISED]);
		expect(files.get('/proj/blender.glb')).toEqual([...GLB]);
	});

	it('refuses a .gltf that points at files beside it', async () => {
		files.set('/proj/a.gltf', enc(JSON.stringify({ buffers: [{ uri: 'a.bin' }] })));
		expect((await call({ path: 'a.gltf' })).result).toMatch(/embed its buffers/);
	});

	it('refuses bad arguments', async () => {
		expect((await call({ path: 'a.png' })).result).toMatch(/path must be/);
		expect((await call({ path: 'a.js', height: 0 })).result).toMatch(/height must be/);
		expect((await call({ path: 'a.js', max_triangles: -1 })).result).toMatch(/max_triangles/);
		expect((await call({ path: 'a.js', out: 'a.obj' })).result).toMatch(/out must end in \.glb/);
	});

	it('refuses in a read-only session before running anything', async () => {
		files.set('/proj/a.js', enc(MODULE));
		const out = await call({ path: 'a.js' }, ctx({ codeReadOnly: true }));
		expect(out.result).toMatch(/read-only/);
		expect(runner.runBuildModule).not.toHaveBeenCalled();
	});

	it('leaves the sheet out for a model without vision', async () => {
		files.set('/proj/a.js', enc(MODULE));
		const c = ctx({ visionSupported: false });
		const out = await call({ path: 'a.js' }, c);
		expect(c.pendingImages).toEqual([]);
		expect(out.result).not.toContain(SHEET_NOTE);
	});

	it('shows one clip moving when asked, with the motion note', async () => {
		files.set('/proj/a.js', enc(MODULE));
		glb.checkGlb.mockResolvedValueOnce({
			bytes: GLB,
			report: {},
			text: 'Clip Walk: 1.00 s.',
			png: PNG,
			clip: 'Walk'
		});
		const out = await call({ path: 'a.js', clip: ' Walk ' });
		expect(glb.checkGlb.mock.calls[0][1]).toMatchObject({ clip: 'Walk' });
		expect(out.result).toBe(['Wrote a.glb.', 'Clip Walk: 1.00 s.', MOTION_NOTE].join('\n'));
	});

	it('passes clip through for a .glb, writing nothing', async () => {
		files.set('/proj/b.glb', [...GLB]);
		await call({ path: 'b.glb', clip: 'Idle' });
		expect(glb.checkGlb.mock.calls[0][1]).toMatchObject({ clip: 'Idle' });
		expect(io.write).not.toHaveBeenCalled();
	});

	it('shows a part close up when asked, with the close-up note', async () => {
		files.set('/proj/a.js', enc(MODULE));
		glb.checkGlb.mockResolvedValueOnce({
			bytes: GLB,
			report: {},
			text: 'Size: 1 m',
			png: PNG,
			closeUp: 'Helmet'
		});
		const out = await call({ path: 'a.js', view: ' head ', spec_height: 1.8 });
		expect(glb.checkGlb.mock.calls[0][1]).toMatchObject({ view: 'head', specHeight: 1.8 });
		expect(out.result.split('\n').at(-1)).toBe(closeUpNote('Helmet'));
	});

	it('refuses view with clip, a blank view and a bad spec_height', async () => {
		expect((await call({ path: 'a.js', view: 'head', clip: 'Walk' })).result).toMatch(
			/view or clip, not both/
		);
		expect((await call({ path: 'a.js', view: ' ' })).result).toMatch(/view must be/);
		expect((await call({ path: 'a.js', spec_height: -1 })).result).toMatch(/spec_height must be/);
	});

	it('refuses a blank clip', async () => {
		expect((await call({ path: 'a.js', clip: '  ' })).result).toMatch(/clip must be/);
	});

	it('says which tracks name a node the model does not have', async () => {
		files.set('/proj/a.js', enc(MODULE));
		runner.runBuildModule.mockResolvedValueOnce({
			glb: GLB,
			errors: [],
			missingTracks: ['Tail.quaternion', 'Wing_L.position']
		});
		const out = await call({ path: 'a.js' });
		expect(out.result.split('\n')[1]).toBe(
			"Tracks naming a node the model doesn't have (the exporter dropped them, so they do nothing): Tail.quaternion, Wing_L.position."
		);
	});

	it('runs an animation module beside the build module', async () => {
		const ANIM = 'export default () => [];';
		files.set('/proj/m/hero.js', enc(MODULE));
		files.set('/proj/m/hero.anim.js', enc(ANIM));
		const out = await call({ path: 'm/hero.js', anim: 'm/hero.anim.js' });
		expect(runner.runBuildModule.mock.calls[0][0]).toBe(MODULE);
		expect(runner.runBuildModule.mock.calls[0][1]).toMatchObject({ anim: ANIM });
		expect(files.get('/proj/m/hero.glb')).toEqual([...GLB]);
		expect(out.result).toMatch(/^Wrote m\/hero\.glb\./);
	});

	it('names the animation module in its errors, and asks to fix it', async () => {
		files.set('/proj/a.js', enc(MODULE));
		files.set('/proj/a.anim.js', enc(MODULE));
		runner.runBuildModule.mockResolvedValueOnce({
			glb: null,
			errors: [
				{ kind: 'error', message: 'x is not defined', line: 4, file: 'anim' },
				{
					kind: 'error',
					message: 'animate() must return an array of AnimationClip.',
					line: null,
					file: 'anim'
				}
			],
			missingTracks: []
		});
		const out = await call({ path: 'a.js', anim: 'a.anim.js' });
		expect(out.result).toBe(
			[
				'The check failed.',
				'- a.anim.js:4: x is not defined',
				'- a.anim.js: animate() must return an array of AnimationClip.',
				'Fix a.anim.js and call check_3d again.'
			].join('\n')
		);
	});

	it('asks to fix the build module when any error came from it', async () => {
		files.set('/proj/a.js', enc(MODULE));
		files.set('/proj/a.anim.js', enc(MODULE));
		runner.runBuildModule.mockResolvedValueOnce({
			glb: null,
			errors: [
				{ kind: 'error', message: 'bad', line: 2, file: 'build' },
				{ kind: 'error', message: 'worse', line: 5, file: 'anim' }
			],
			missingTracks: []
		});
		const out = await call({ path: 'a.js', anim: 'a.anim.js' });
		expect(out.result).toContain('- line 2: bad\n- a.anim.js:5: worse\nFix a.js and call');
	});

	it('refuses an animation module it cannot use', async () => {
		files.set('/proj/a.js', enc(MODULE));
		expect((await call({ path: 'a.glb', anim: 'a.anim.js' })).result).toMatch(
			/anim works only with a \.js or \.mjs build module/
		);
		expect((await call({ path: 'a.js', anim: 'a.json' })).result).toMatch(
			/anim must be a \.js or \.mjs module/
		);
		expect((await call({ path: 'a.js', anim: 'a.js' })).result).toMatch(/different file/);
		expect((await call({ path: 'a.js', anim: 'missing.anim.js' })).result).toMatch(
			/Could not read missing\.anim\.js/
		);
		expect(runner.runBuildModule).not.toHaveBeenCalled();
	});

	describe('kit.texture', () => {
		const PNG_BYTES = [137, 80, 78, 71];
		const uses = (...paths: string[]) =>
			`export default (T, kit) => { ${paths.map((p) => `kit.texture('${p}');`).join(' ')} };`;

		it('reads the PNGs from beside the module, from both modules, keyed as written', async () => {
			files.set('/proj/m/crate.js', enc(uses('tex/wood.png')));
			files.set('/proj/m/crate.anim.js', enc(uses('../shared/metal.png', 'tex/wood.png')));
			files.set('/proj/m/tex/wood.png', PNG_BYTES);
			files.set('/proj/shared/metal.png', [1, 2, 3]);
			await call({ path: 'm/crate.js', anim: 'm/crate.anim.js' });
			expect(runner.runBuildModule.mock.calls[0][1].textures).toEqual({
				'tex/wood.png': 'data:image/png;base64,iVBORw==',
				'../shared/metal.png': 'data:image/png;base64,AQID'
			});
		});

		it('passes no textures when the module names none', async () => {
			files.set('/proj/a.js', enc(MODULE));
			await call({ path: 'a.js' });
			expect(runner.runBuildModule.mock.calls[0][1].textures).toEqual({});
		});

		it('refuses a PNG outside the working folder', async () => {
			files.set('/proj/m/a.js', enc(uses('../../secret.png')));
			const out = await call({ path: 'm/a.js' });
			expect(out.result).toMatch(/must be inside the working folder/);
			expect(runner.runBuildModule).not.toHaveBeenCalled();
		});

		it('refuses an absolute path, and an absolute module climbing out', async () => {
			files.set('/proj/a.js', enc(uses('/etc/x.png')));
			expect((await call({ path: 'a.js' })).result).toMatch(/inside the working folder/);
			files.set('/proj/b.js', enc(uses('../x.png')));
			expect((await call({ path: '/proj/b.js' })).result).toMatch(/inside the working folder/);
		});

		it('refuses a file that is not a PNG', async () => {
			files.set('/proj/a.js', enc(uses('bark.jpg')));
			expect((await call({ path: 'a.js' })).result).toMatch(/only \.png files/);
		});

		it('refuses a PNG over the size limit', async () => {
			files.set('/proj/a.js', enc(uses('big.png')));
			files.set('/proj/big.png', new Array(4 * 1024 * 1024 + 1).fill(0));
			expect((await call({ path: 'a.js' })).result).toMatch(/over 4 MB/);
			expect(runner.runBuildModule).not.toHaveBeenCalled();
		});

		it('refuses more than eight PNGs', async () => {
			const names = Array.from({ length: 9 }, (_, i) => `t${i}.png`);
			files.set('/proj/a.js', enc(uses(...names)));
			expect((await call({ path: 'a.js' })).result).toMatch(/names 9 PNGs; use at most 8/);
		});

		it('says which PNG it could not read', async () => {
			files.set('/proj/m/a.js', enc(uses('bark.png')));
			expect((await call({ path: 'm/a.js' })).result).toMatch(/Could not read m\/bark\.png/);
		});
	});

	it('is a core tool, in no deferred family', () => {
		const cat = toolCategory('check_3d')!;
		expect(TOOL_FAMILIES.some((f) => f.has('check_3d', cat))).toBe(false);
	});
});
