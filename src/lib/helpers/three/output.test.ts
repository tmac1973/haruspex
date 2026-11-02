import { describe, expect, it } from 'vitest';
import { check3dFile, defaultGlbPath } from './output';

describe('check3dFile', () => {
	it('is the out file when one is given', () => {
		expect(check3dFile({ path: 'imp.js', out: 'assets/imp.glb' })).toBe('assets/imp.glb');
		expect(check3dFile({ path: 'rock.glb', out: 'rock_2m.glb' })).toBe('rock_2m.glb');
	});

	it("is a module's own .glb, or the model it was given", () => {
		expect(check3dFile({ path: 'assets/imp.js' })).toBe('assets/imp.glb');
		expect(check3dFile({ path: 'a.mjs' })).toBe('a.glb');
		expect(check3dFile({ path: 'blender.gltf' })).toBe('blender.gltf');
	});

	it('is null for arguments that name no model', () => {
		expect(check3dFile({ path: 'a.png' })).toBeNull();
		expect(check3dFile(undefined)).toBeNull();
	});
});

describe('defaultGlbPath', () => {
	it('swaps a module extension for .glb', () => {
		expect(defaultGlbPath('x/y.JS')).toBe('x/y.glb');
	});
});
