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

/** A change of speed at the seam under this share of the height a second is too small to see. */
const HITCH_MIN = 0.1;
/** One-shots that end away from the rest pose on purpose. */
const ENDS_DOWN = /die|death|dead|fall|sit|sleep|lie|knock|faint/i;

const mps = (v: number) => `${v.toFixed(2)} m/s`;

/** Whether a loop changes speed at its seam: it hitches each time it repeats. */
export const hitches = (c: ClipMotion) =>
	c.loop && !!c.hitch && c.hitch.jump > HITCH_MIN * Math.max(1, c.height);

/** Whether a one-shot's end is away from both the rest pose and Idle's first pose (m). */
const awayFrom = (rest: number, idle: number | undefined, limit: number) =>
	rest > limit && !(idle !== undefined && idle <= limit);

/** `, 5 cm and 8 cm from Idle's first pose` for the ends that are off, or `''` with no Idle. */
function fromIdle(i: ClipMotion['fromIdle'], start: boolean, end: boolean): string {
	if (!i) return '';
	const off = [start && cm(i.start), end && cm(i.end)].filter(Boolean).join(' and ');
	return `, ${off} from ${i.clip}'s first pose`;
}

/**
 * One-shots that start or end away from both the rest pose and Idle's first
 * pose, so a game's blend into or out of them pops.
 */
function restProblems(c: ClipMotion): string[] {
	if (c.loop) return [];
	const limit = seamLimit(c);
	const { fromRest: r, fromIdle: i } = c;
	const starts = awayFrom(r.start, i?.start, limit);
	const ends = awayFrom(r.end, i?.end, limit) && !ENDS_DOWN.test(c.name);
	if (!starts && !ends) return [];
	const to = i ? `the rest pose or ${i.clip}'s first pose` : 'the rest pose';
	const why = `a one-shot starts and ends at ${to}, so the game can blend into and out of it`;
	// Both ends at one pose: say so, or a model keys a new last pose for a first one that is off.
	if (starts && ends && c.seam <= limit) {
		return [
			`starts and ends at the same pose, ${cm(r.start)} from the rest pose (${r.startPart})${fromIdle(i, true, false)}: ${why}`
		];
	}
	const parts = [...new Set([starts && r.startPart, ends && r.endPart].filter(Boolean))].join(', ');
	const where = [starts && `starts ${cm(r.start)}`, ends && `ends ${cm(r.end)}`].filter(Boolean);
	return [
		`${where.join(' and ')} from the rest pose (${parts})${fromIdle(i, starts, ends)}: ${why}`
	];
}

/** What the clip's keys could do better, which never fails it: too sparse, or too dense. */
export function clipNotes(c: ClipMotion): string[] {
	const out: string[] = [];
	const { sparse, dense } = c;
	if (sparse.tracks.length) {
		const more = sparse.tracks.length > 1 ? ` and ${sparse.tracks.length - 1} more` : '';
		out.push(
			`keys up to ${sec(sparse.gap)} apart on ${sparse.tracks[0]}${more}: straight lines between them read as mechanical, so key at least every 0.25 s`
		);
	}
	if (dense.tracks) {
		out.push(
			`${Math.round(dense.perSecond)} keys a second on ${dense.tracks} track${dense.tracks === 1 ? '' : 's'}: 30 is plenty for a game and keeps the file small`
		);
	}
	return out;
}

/** Whether a looping clip carries the body across the floor instead of playing in place. */
export const travels = (c: ClipMotion) => c.loop && c.travel > seamLimit(c);

/** Loops that don't close, and walks that don't play in place. */
function loopProblems(c: ClipMotion): string[] {
	const out: string[] = [];
	if (travels(c)) {
		// Name what to change: the track whose own keys move that far, or, when
		// none does, the parts moving together (a hip sway, feet keyed in world
		// space), so a model doesn't add a root track to cancel drift no track made.
		const track = c.travelTrack
			? ` (${c.travelTrack} moves ${cm(c.travelTrackFar)} by its own keys)`
			: ' (no one track carries it: the parts move forward together)';
		const feet = c.locomotion ? ', with its planted feet moving back instead' : '';
		out.push(
			`carries the body ${cm(c.travel)} ${way(c.travelDir)}${track}: a game moves the model itself, so it would move twice and jump back each loop. Play it in place${feet}`
		);
	} else if (c.loop && c.seam > seamLimit(c)) {
		const part = c.seamPart ? ` (${c.seamPart} moves most)` : '';
		out.push(
			`loops but ends ${cm(c.seam)} from where it starts${part}: make its last pose its first`
		);
	} else if (hitches(c) && c.hitch) {
		out.push(
			`hitches at the loop point: ${c.hitch.part} changes speed by ${mps(c.hitch.jump)} there, against a mean speed of ${mps(c.hitch.speed)}, and most parts change too. Make its last keys lead into its first`
		);
	}
	return [...out, ...treadmillProblems(c)];
}

/** A walk in place whose planted feet don't move back. */
function treadmillProblems(c: ClipMotion): string[] {
	const out: string[] = [];
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
	out.push(...c.sanity, ...loopProblems(c), ...restProblems(c));
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
			const notes = clipNotes(c);
			const note = notes.length ? ` Note: ${notes.join('; ')}.` : '';
			const set = c.declared.length ? `, set as ${c.declared.join(' and ')}` : '';
			return `- ${c.name} (${c.duration.toFixed(2)} s, ${c.tracks} tracks, ends ${cm(c.seam)} from its start${inPlace}${set}): ${p.length ? p.join('; ') : 'no problems found'}.${note}`;
		})
	];
}

/** One clip's detail; `sheet` says the motion sheet came with it. */
export function formatClip(c: ClipMotion, sheet: boolean): string[] {
	const p = clipProblems(c);
	const set = c.declared.length ? `, set as ${c.declared.join(' and ')}` : '';
	const lines = [`Clip ${c.name}: ${c.duration.toFixed(2)} s, ${c.tracks} tracks${set}.`];
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
			: 'No knee or elbow joints found by name: a pivot or bone named like Knee_L or Elbow_R, with the lower limb (a pivot or a mesh) under it, has its fold checked.',
		`Ends ${cm(c.seam)} from where it starts${c.seamPart ? ` (${c.seamPart} moves most)` : ''}: a loop needs this near 0.`,
		`Starts ${cm(c.fromRest.start)} and ends ${cm(c.fromRest.end)} from the rest pose${c.fromIdle ? `, ${cm(c.fromIdle.start)} and ${cm(c.fromIdle.end)} from ${c.fromIdle.clip}'s first pose` : ''}.`,
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
		p.length ? `Problems: ${p.join('; ')}.` : 'No problems found.',
		...clipNotes(c).map((n) => `Note: ${n}.`)
	);
	return lines;
}
