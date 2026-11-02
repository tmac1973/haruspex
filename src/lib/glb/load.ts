/**
 * Loading a GLB to look at it: the shared start of the GLB report, the render
 * sheet and normalisation. `three` is imported here and nowhere at the top
 * level, so it stays in a chunk of its own until the first GLB loads.
 */
import type { AnimationClip, Material, Mesh, Object3D, Texture } from 'three';

export type Three = typeof import('three');

/** What a GLB holds, as these modules use it. */
export interface LoadedGlb {
	scene: Object3D;
	animations: AnimationClip[];
}

/** The bundled `three`, loaded on first use. */
export function loadThree(): Promise<Three> {
	return import('three');
}

/** Parse GLB bytes, or say why they didn't parse. */
export async function loadGlb(
	bytes: Uint8Array
): Promise<{ gltf: LoadedGlb; THREE: Three } | { error: string }> {
	const THREE = await loadThree();
	const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	try {
		const gltf = await new GLTFLoader().parseAsync(buffer as ArrayBuffer, '');
		return { gltf: { scene: gltf.scene, animations: gltf.animations }, THREE };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return { error: `The GLB did not load: ${message}` };
	}
}

/** Free a loaded scene's geometry, materials and textures. */
export function disposeTree(root: Object3D): void {
	root.traverse((o) => {
		const mesh = o as Mesh;
		if (!mesh.isMesh) return;
		mesh.geometry.dispose();
		const mats: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
		for (const m of mats) {
			for (const value of Object.values(m)) {
				if ((value as Texture | null)?.isTexture) (value as Texture).dispose();
			}
			m.dispose();
		}
	});
}
