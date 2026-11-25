/**
 * What a build module and an animation module are, word for word as the 3D
 * models job (`#lib/agent/jobs/types/model-generation/prompts.ts`) and the 3D
 * delegate (`delegatePrompt.ts`) both state it.
 */

/** The rig rule, word for word in every creation prompt: animation depends on it. */
export const RIG_RULE =
	'Every name in Parts is an Object3D pivot placed at the joint it turns about, holding the ' +
	'meshes it moves, nested parent → child (Pelvis > Hip_L > Knee_L > Foot_L). Animation ' +
	'rotates these pivots and moves Pelvis, and nothing else.';

/**
 * What a build module is, as the creation prompt and the 3D delegate
 * (`delegatePrompt.ts`) both state it: one bullet a line.
 * `textures` adds kit.texture.
 */
export function buildModuleRules(textures: boolean): string[] {
	return [
		'- `export default function build(THREE, kit)` returns one Object3D. No imports.',
		'- kit: mergeGeometries, mergeVertices, RoundedBoxGeometry, ConvexGeometry,',
		'  ParametricGeometry, random(seed) (a function giving [0, 1)), createNoise(seed)',
		'  (an object: noise2(x, y) and noise3(x, y, z), each in [-1, 1])' +
			(textures ? ', texture(path).' : '.'),
		'- Units are metres, y is up, the front faces +z, the feet stand on y = 0.',
		'- Name every mesh.'
	];
}

/** What an animation module is and which nodes it moves, shared as `buildModuleRules` is. */
export const ANIM_MODULE_RULES: readonly string[] = [
	'- `export default function animate(THREE, object, kit)` returns an array of',
	'  THREE.AnimationClip. No imports. `object` is what the build module returned.',
	"- Find each pivot with `object.getObjectByName('Hip_L')`. Animate only the named",
	'  pivots: QuaternionKeyframeTrack on `<name>.quaternion`, VectorKeyframeTrack on',
	'  `<name>.position`. Start from each pivot’s rest pose (its current quaternion and',
	'  position) and move away from it. Move Pelvis down and up so the hips drop with',
	'  each step; turn each Foot to keep its sole flat while planted, and each Hand to',
	'  finish a swing.'
];

/** How loops, one-shots and walks must move, shared as `buildModuleRules` is. */
export const CLIP_MOTION_RULES: readonly string[] = [
	'- A looping clip ends on exactly its first pose, moving as it does at the start.',
	'  A one-shot starts and ends at the rest pose or Idle’s first pose, so the game can',
	'  blend into it.',
	'- A walk or run plays in place, since the game moves the model: the body stays over',
	'  the origin, and each planted foot moves back (−z) at one steady speed, then lifts.'
];
