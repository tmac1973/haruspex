/**
 * The page side of `motion-sheet.mjs`: the app's own clip checks and motion
 * sheet, bundled into a plain page so a script can judge an agent's clips
 * exactly as `check_3d` shows them.
 */
import { loadGlb } from '#lib/glb/load.ts';
import { inspectMotion } from '#lib/glb/motion.ts';
import { formatClip, formatClipLines } from '#lib/glb/motionFormat.ts';
import { renderMotionSheet } from '#lib/glb/motionSheet.ts';

async function motionSheet(bytes: number[], clip: string) {
	const loaded = await loadGlb(new Uint8Array(bytes));
	if ('error' in loaded) return { error: loaded.error };
	const clips = inspectMotion(loaded.THREE, loaded.gltf);
	const motion = clips.find((c) => c.name === clip);
	const anim = loaded.gltf.animations.find((a) => a.name === clip);
	if (!motion || !anim) {
		return { error: `No clip named ${clip}. Clips: ${clips.map((c) => c.name).join(', ')}.` };
	}
	const png = renderMotionSheet(loaded.THREE, loaded.gltf.scene, anim, motion.fastest);
	return { text: [...formatClipLines(clips), ...formatClip(motion, png !== null)].join('\n'), png };
}

(window as unknown as { motionSheet: typeof motionSheet }).motionSheet = motionSheet;
