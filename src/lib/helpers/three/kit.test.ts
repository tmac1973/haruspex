import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REVISION } from 'three';
import { threeKitUrl } from './kitUrl';

const BUNDLE = join(process.cwd(), 'static/helpers/three-kit.js');

describe('threeKitUrl', () => {
	it('points at the bundle on the app origin', () => {
		expect(threeKitUrl('tauri://localhost')).toBe('tauri://localhost/helpers/three-kit.js');
		expect(threeKitUrl('http://localhost:1420')).toBe('http://localhost:1420/helpers/three-kit.js');
	});
});

// Built by `npm run build:three-kit` (and so by `npm run dev` / `npm run build`).
describe.skipIf(!existsSync(BUNDLE))('the three-kit bundle', () => {
	it('defines HaruspexThreeKit with the app’s three, the exporter and the kit', () => {
		const g = globalThis as unknown as { HaruspexThreeKit?: Record<string, unknown> };
		delete g.HaruspexThreeKit;
		new Function(readFileSync(BUNDLE, 'utf8'))();
		const k = g.HaruspexThreeKit as unknown as {
			THREE: { REVISION: string };
			GLTFExporter: unknown;
			kit: Record<string, unknown>;
		};
		expect(k.THREE.REVISION).toBe(REVISION);
		expect(typeof k.GLTFExporter).toBe('function');
		expect(Object.keys(k.kit).sort()).toEqual(
			[
				'ConvexGeometry',
				'ParametricGeometry',
				'RoundedBoxGeometry',
				'createNoise',
				'mergeGeometries',
				'mergeVertices',
				'random',
				'texture'
			].sort()
		);
	});

	it('hands out the textures the runner set, and names a path it has not', () => {
		const g = globalThis as unknown as { HaruspexThreeKit?: Record<string, unknown> };
		new Function(readFileSync(BUNDLE, 'utf8'))();
		const k = g.HaruspexThreeKit as unknown as {
			kit: { texture: (p: string) => unknown };
			setTextures: (m: Record<string, unknown>) => void;
		};
		const bark = { isTexture: true };
		k.setTextures({ 'textures/bark.png': bark });
		expect(k.kit.texture('textures/bark.png')).toBe(bark);
		expect(() => k.kit.texture('leaf.png')).toThrow(/kit\.texture\("leaf\.png"\): no such PNG/);
	});
});
