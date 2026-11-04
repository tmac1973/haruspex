/**
 * The clip checks as text: one line per clip for every report, and one
 * clip's detail when the model asked to see it move.
 */
import {
	FLOOR_LIFT,
	FLOOR_SINK,
	LOOP_SEAM,
	type ClipMotion,
	type TimeSpan
} from '#lib/glb/motion.ts';

/** At most this many of each kind of finding per clip. */
const EACH = 6;

const cm = (m: number) => `${Math.round(m * 100)} cm`;
const sec = (t: number) => `${t.toFixed(2)} s`;
const span = (s: TimeSpan) => (s.from === s.to ? sec(s.from) : `${sec(s.from)}–${sec(s.to)}`);

function capped<T>(items: T[], say: (x: T) => string, more: string): string[] {
	const out = items.slice(0, EACH).map(say);
	if (items.length > EACH) out.push(`and ${items.length - EACH} more ${more}`);
	return out;
}

const speed = (v: { x: number; z: number }) => `${Math.hypot(v.x, v.z).toFixed(2)} m/s`;

/** Which way a floor offset points, in the model's own terms (the front is +z). */
function way([x, z]: [number, number]): string {
	if (Math.abs(x) > Math.abs(z)) return 'sideways';
	return z > 0 ? 'forward' : 'back';
}

/** How far a looping clip's last pose may sit from its first (m). */
export const seamLimit = (c: Pick<ClipMotion, 'height'>) => Math.max(0.01, LOOP_SEAM * c.height);

/** Whether a looping clip carries the body across the floor instead of playing in place. */
export const travels = (c: ClipMotion) => c.loop && c.travel > seamLimit(c);

/** Loops that don't close, and walks that don't play in place. */
function loopProblems(c: ClipMotion): string[] {
	const out: string[] = [];
	if (travels(c)) {
		const track = c.travelTrack ? ` (${c.travelTrack})` : '';
		const feet = c.locomotion ? ', with its planted feet moving back instead' : '';
		out.push(
			`carries the body ${cm(c.travel)} ${way(c.travelDir)}${track}: a game moves the model itself, so it would move twice and jump back each loop. Play it in place${feet}`
		);
	} else if (c.loop && c.seam > seamLimit(c)) {
		const part = c.seamPart ? ` (${c.seamPart} moves most)` : '';
		out.push(
			`loops but ends ${cm(c.seam)} from where it starts${part}: make its last pose its first`
		);
	}
	if (!c.locomotion || !c.stance || travels(c)) return out;
	if (!c.treadmill) {
		out.push(
			'its planted feet stand still: in place, a walk moves them back (−z) at its walking speed, or they skate in a game'
		);
	} else if (c.stance.z > 0 && c.stance.z >= Math.abs(c.stance.x) && !/back/i.test(c.name)) {
		out.push(
			'its planted feet move forward (+z): in place, a forward walk moves them back (−z). Does the front face +z?'
		);
	}
	return out;
}

/** What is wrong with a clip, as short phrases; empty when nothing is. */
export function clipProblems(c: ClipMotion): string[] {
	const out: string[] = [];
	if (c.sink > FLOOR_SINK) out.push(`through the floor by ${cm(c.sink)} at ${sec(c.sinkAt)}`);
	if (c.lift > FLOOR_LIFT && !c.airborne) {
		out.push(`off the floor by ${cm(c.lift)} at ${sec(c.liftAt)}`);
	}
	out.push(...c.sanity, ...loopProblems(c));
	out.push(
		...capped(
			c.passes,
			(p) => `${p.part} passes into ${p.into} at ${span(p)}`,
			'parts passing into others'
		),
		...capped(
			c.apart,
			(p) => `${p.part} comes away from the body at ${span(p)} (is it under the right node?)`,
			'parts coming away'
		),
		...capped(
			c.slides,
			(s) =>
				c.treadmill
					? `${s.part} slips ${s.cm} cm against the treadmill at ${span(s)}`
					: `${s.part} slides ${s.cm} cm while planted at ${span(s)}`,
			'sliding parts'
		),
		...capped(
			c.joints,
			(j) => `${j.joint} bends the wrong way by ${j.degrees}° at ${span(j)}`,
			'joints'
		),
		...capped(
			c.jumps,
			(j) => `${j.track} turns ${j.degrees}° between two keys at ${sec(j.at)}`,
			'jumps'
		)
	);
	if (c.dead.length) out.push(`tracks that never move: ${c.dead.slice(0, EACH).join(', ')}`);
	return out;
}

/** One line per clip under a heading; `''` for no clips. */
export function formatClipLines(clips: ClipMotion[]): string[] {
	if (!clips.length) return [];
	return [
		'Clip checks (pass clip to see one moving):',
		...clips.map((c) => {
			const p = clipProblems(c);
			const inPlace = c.treadmill && c.stance ? `, in place at ${speed(c.stance)}` : '';
			return `- ${c.name} (${c.duration.toFixed(2)} s, ${c.tracks} tracks, ends ${cm(c.seam)} from its start${inPlace}): ${p.length ? p.join('; ') : 'no problems found'}.`;
		})
	];
}

/** One clip's detail; `sheet` says the motion sheet came with it. */
export function formatClip(c: ClipMotion, sheet: boolean): string[] {
	const p = clipProblems(c);
	const lines = [`Clip ${c.name}: ${c.duration.toFixed(2)} s, ${c.tracks} tracks.`];
	if (sheet) {
		lines.push(
			`Motion sheet: top row 8 frames from the right, middle row the same from the front, bottom all frames overlaid (later ones darker) with trails of the parts that move most (${c.fastest.join(', ') || 'none'}), a dot where each starts.`
		);
	}
	lines.push(
		c.rig === 'skinned'
			? `Rig: skinned, ${c.bones} bones.`
			: `Rig: rigid, ${c.bones} animated nodes.`,
		c.jointsChecked.length
			? `Joints checked: ${c.jointsChecked.join(', ')}.`
			: 'No knee or elbow joints found by name.',
		`Ends ${cm(c.seam)} from where it starts${c.seamPart ? ` (${c.seamPart} moves most)` : ''}: a loop needs this near 0.`,
		c.reachPart
			? `Key pose: ${c.reachPart} gets ${cm(c.reach)} from where it starts (${Math.round((100 * c.reach) / (c.height || 1))}% of the model's height), at ${sec(c.reachAt)}. A timid key pose reads as no motion in a game: push it further if it is.`
			: 'Nothing moves.',
		`The model's centre wanders ${cm(c.drift)} across the floor.`,
		...(c.treadmill && c.stance
			? [
					`In place: its planted feet move back at ${speed(c.stance)}, the speed a game should move the model at.`
				]
			: []),
		...(c.slides.length
			? [
					c.treadmill
						? 'A planted foot should move back steadily at that speed, as on a treadmill, and leave the floor before it slows.'
						: 'A planted part should stay put: turn the joint above it against the body, or lift it off the floor.'
				]
			: []),
		p.length ? `Problems: ${p.join('; ')}.` : 'No problems found.'
	);
	return lines;
}
