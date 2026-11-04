/**
 * The parts a planner writes for a model that moves: the pivots a two- or
 * four-legged rig needs so its clips can drop the hips, keep a sole flat on
 * the floor and finish a swing at the wrist. The helper on/off tests showed
 * rigs without them: every animator worked around a fixed pelvis and rigid
 * ankles. Shared by the spec prompts of the models job and guided planning.
 */

/** A two-legged rig, parent before child. `Pelvis` moves as well as turns. */
export const HUMANOID_PARTS = [
	'Pelvis',
	'Spine',
	'Neck',
	'Shoulder_L',
	'Elbow_L',
	'Hand_L',
	'Shoulder_R',
	'Elbow_R',
	'Hand_R',
	'Hip_L',
	'Knee_L',
	'Foot_L',
	'Hip_R',
	'Knee_R',
	'Foot_R'
] as const;

/**
 * A four-legged rig: F and H for the front and hind legs. Each leg's middle
 * joint is a Knee, which folds back, as a bear's or a horse's front leg does.
 */
export const QUADRUPED_PARTS = [
	'Pelvis',
	'Spine',
	'Neck',
	...['FL', 'FR'].flatMap((s) => [`Shoulder_${s}`, `Knee_${s}`, `Foot_${s}`]),
	...['HL', 'HR'].flatMap((s) => [`Hip_${s}`, `Knee_${s}`, `Foot_${s}`])
];

/** The parts rule for a spec prompt, as indented lines under its parts item. */
export const RIG_PARTS_LINES = [
	'     at its joints, written Side_Part. A two-legged model has at least',
	`     ${HUMANOID_PARTS.join(', ')}.`,
	'     A four-legged one has at least',
	`     ${QUADRUPED_PARTS.join(', ')}.`,
	'     Add what else moves (Head, Jaw, Tail, Wing_L). Every pivot a clip moves',
	'     must be listed.'
];
