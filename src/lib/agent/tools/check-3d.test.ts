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
import { TOOL_FAMILIES } from '#lib/agent/tools/families.ts';
import { toolCategory } from '#lib/agent/tools/registry.ts';
import { SHEET_NOTE } from './check-3d';

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
	runner.runBuildModule.mockReset().mockResolvedValue({ glb: GLB, errors: [] });
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
		expect(glb.checkGlb.mock.calls[0][1]).toEqual({ height: 1.8, ground: true, maxTriangles: 500 });
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

	it('is a core tool, in no deferred family', () => {
		const cat = toolCategory('check_3d')!;
		expect(TOOL_FAMILIES.some((f) => f.has('check_3d', cat))).toBe(false);
	});
});
