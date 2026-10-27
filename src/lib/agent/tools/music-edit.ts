/**
 * `edit_music`: a new song from one the user already has: restyled, with a
 * stretch redone, extended at either end, with an instrument added or pulled
 * out, or filled in around a part. ACE-Step's tasks on a source song
 * (`cover`, `repaint`, `lego`, `extract`, `complete`), made by the music
 * backend in Settings → Music and answered like `generate_music`: kept in
 * the audio cache, played in the answer, and saved to `path` if asked.
 *
 * The source is a song made earlier in the conversation (its
 * `haruspex-audio://` URL) or a file in the working folder
 * (`_musicSource.ts`). Offered wherever `generate_music` is; a model that
 * can't run the action (stem tasks on a turbo model) is a sentence here.
 */
import { getSettings } from '#lib/stores/settings.ts';
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import {
	SEED_PARAM,
	parseMusicArgs,
	runMusic,
	type MusicArgs
} from '#lib/agent/tools/music-gen.ts';
import {
	MAX_SOURCE_SECONDS,
	resolveSong,
	type MusicSource
} from '#lib/agent/tools/_musicSource.ts';
import { resolveMusicBackend, MUSIC_TRACKS, type MusicTask } from '#lib/music/index.ts';
import { BACKGROUND_PARAM } from '#lib/agent/tools/_musicJob.ts';

export const ACTIONS = {
	restyle: 'cover',
	redo: 'repaint',
	extend: 'repaint',
	add_instrument: 'lego',
	extract_instrument: 'extract',
	complete: 'complete'
} as const satisfies Record<string, MusicTask>;

export type EditAction = keyof typeof ACTIONS;

const MAX_EXTEND_SECONDS = 240;
const DEFAULT_EXTEND_SECONDS = 30;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const round = (s: number) => Math.round(s * 10) / 10;

/** The instruments named, as a list: an array, or one string split at commas. */
function instruments(v: unknown): string[] {
	const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
	return list.map((x) => String(x).trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);
}

function badInstrument(names: string[]): string | null {
	const bad = names.find((n) => !(MUSIC_TRACKS as readonly string[]).includes(n));
	return bad ? `"${bad}" is not an instrument it knows: ${MUSIC_TRACKS.join(', ')}.` : null;
}

type Req = MusicArgs['req'];
/** One action's part of the request, or what is wrong with its arguments. */
type ActionFields = (
	args: Record<string, unknown>,
	len: number,
	tracks: string[]
) => Partial<Req> | string;

function restyle(args: Record<string, unknown>): Partial<Req> | string {
	const strength = num(args.strength);
	if (strength === undefined) return {};
	if (strength < 0 || strength > 1) return 'strength must be between 0 and 1.';
	return { coverStrength: strength };
}

function redo(args: Record<string, unknown>, len: number): Partial<Req> | string {
	const start = num(args.start_seconds) ?? 0;
	const end = num(args.end_seconds) ?? len;
	if (start < 0 || end > len + 0.5) {
		return `start_seconds and end_seconds must be within the song (0–${round(len)} s).`;
	}
	if (end - start < 1) return 'end_seconds must be at least a second after start_seconds.';
	return { repaintStart: start, repaintEnd: end >= len ? -1 : end };
}

function extend(args: Record<string, unknown>, len: number): Partial<Req> | string {
	const add = num(args.seconds) ?? DEFAULT_EXTEND_SECONDS;
	if (add < 1 || add > MAX_EXTEND_SECONDS) {
		return `seconds must be between 1 and ${MAX_EXTEND_SECONDS}.`;
	}
	if (len + add > MAX_SOURCE_SECONDS) {
		return `The song would be ${Math.round(len + add)} s; songs can be up to ${MAX_SOURCE_SECONDS} s.`;
	}
	const durationSec = round(len + add);
	// A window past the end adds music there; one before the start adds an
	// intro, and an end of -1 then means the source's start.
	return str(args.at) === 'start'
		? { repaintStart: -add, repaintEnd: -1, durationSec }
		: { repaintStart: round(len), repaintEnd: durationSec, durationSec };
}

function oneInstrument(action: string): ActionFields {
	return (_args, _len, tracks) => {
		if (tracks.length !== 1) return `${action} needs one "instrument".`;
		return badInstrument(tracks) ?? { tracks };
	};
}

function complete(_args: Record<string, unknown>, _len: number, tracks: string[]) {
	return badInstrument(tracks) ?? (tracks.length ? { tracks } : {});
}

const FIELDS: Record<EditAction, ActionFields> = {
	restyle,
	redo,
	extend,
	add_instrument: oneInstrument('add_instrument'),
	extract_instrument: oneInstrument('extract_instrument'),
	complete
};

/**
 * The request for `action` on `source`, or what is wrong. Pure, so the
 * arithmetic of windows and lengths tests without a song.
 */
export function parseEditArgs(
	args: Record<string, unknown>,
	source: MusicSource
): MusicArgs | string {
	const action = str(args.action) as EditAction;
	if (!(action in ACTIONS)) return `action must be one of ${Object.keys(ACTIONS).join(', ')}.`;
	const task = ACTIONS[action];
	const tracks = instruments(args.instruments ?? args.instrument);
	let caption = str(args.caption);
	if (!caption) {
		if (action !== 'extract_instrument') return `edit_music ${action} needs a "caption".`;
		caption = tracks.join(', ') || 'isolated track';
	}
	const base = parseMusicArgs({ ...args, caption }, getSettings().musicDefaultDurationSec);
	if (typeof base === 'string') return base;
	const fields = FIELDS[action](args, source.seconds, tracks);
	if (typeof fields === 'string') return fields;
	const req: Req = {
		...base.req,
		task,
		source: source.input,
		durationSec: round(source.seconds),
		...fields
	};
	// A stem task has no lyrics unless it was given some; "[Instrumental]" is
	// for the tasks that write a whole mix.
	if (task === 'lego' || task === 'extract' || task === 'complete') req.instrumental = false;
	return { ...base, req };
}

/** Why the configured model can't run `task`, or null. */
async function unsupported(task: MusicTask): Promise<string | null> {
	let tasks: MusicTask[];
	try {
		tasks = await resolveMusicBackend().tasks();
	} catch (e) {
		return `Could not reach the music server: ${errMessage(e)}`;
	}
	if (tasks.includes(task)) return null;
	if (tasks.length <= 1) {
		return 'The music server in Settings → Music only makes new songs; update it to work on existing ones.';
	}
	return (
		'The music model in Settings → Music can only ' +
		'restyle, redo or extend a song; adding, pulling out or completing instruments needs a base model, such as ACE-Step 1.5 XL base.'
	);
}

registerTool({
	category: 'music',
	schema: {
		type: 'function',
		function: {
			name: 'edit_music',
			description:
				'Make a new version of an existing song: restyle it, redo a stretch, extend it, or add, ' +
				'pull out or complete instruments. Uses the music generation in Settings → Music and ' +
				'takes a minute or more. The original is kept.',
			parameters: {
				type: 'object',
				properties: {
					source: {
						type: 'string',
						description:
							'The song: a haruspex-audio:// URL from this conversation, or an audio file in the ' +
							'working folder.'
					},
					action: {
						type: 'string',
						enum: Object.keys(ACTIONS),
						description:
							'restyle: the same song in a new style. redo: regenerate start_seconds–end_seconds. ' +
							'extend: add seconds at the end (or the start). add_instrument / ' +
							'extract_instrument: one instrument. complete: fill in instruments around it.'
					},
					caption: {
						type: 'string',
						description:
							'The style, as comma-separated tags: the new style, what the new part sounds like, ' +
							'or what the added instrument plays. Not needed for extract_instrument.'
					},
					lyrics: {
						type: 'string',
						description:
							'Lyrics with [verse]/[chorus] tags. A restyle sings these; pass the original lyrics ' +
							'to keep them. Omit for no vocals.'
					},
					strength: {
						type: 'number',
						description:
							'restyle only, 0–1: how closely to follow the original. 1 keeps its structure; ' +
							'about 0.2 is a loose restyle.'
					},
					start_seconds: { type: 'number', description: 'redo: where to start. Default 0.' },
					end_seconds: { type: 'number', description: 'redo: where to stop. Default the end.' },
					seconds: {
						type: 'number',
						description: `extend: how much to add, 1 to ${MAX_EXTEND_SECONDS}. Default ${DEFAULT_EXTEND_SECONDS}.`
					},
					at: {
						type: 'string',
						enum: ['end', 'start'],
						description: 'extend: where. Default end.'
					},
					instrument: {
						type: 'string',
						enum: [...MUSIC_TRACKS],
						description: 'add_instrument / extract_instrument: which.'
					},
					instruments: {
						type: 'array',
						items: { type: 'string', enum: [...MUSIC_TRACKS] },
						description: 'complete: which to add. Omit to let it choose.'
					},
					seed: SEED_PARAM,
					format: { type: 'string', enum: ['mp3', 'wav'], description: 'Default mp3.' },
					title: { type: 'string', description: 'A short title for the player and the file.' },
					path: {
						type: 'string',
						description: 'Also save it here, in the working folder, ending .mp3 or .wav.'
					},
					overwrite: { type: 'boolean', description: 'Replace an existing file. Default false.' },
					background: BACKGROUND_PARAM
				},
				required: ['source', 'action']
			}
		}
	},
	displayLabel: (args) =>
		`music: ${String(args.action ?? 'edit')} ${String(args.title ?? '').slice(0, 50)}`.trim(),
	execute: async (args, ctx) => {
		const action = str(args.action) as EditAction;
		if (!(action in ACTIONS)) {
			return toolResult(toolError(`action must be one of ${Object.keys(ACTIONS).join(', ')}.`));
		}
		const refused = await unsupported(ACTIONS[action]);
		if (refused) return toolResult(toolError(refused));
		const source = await resolveSong(str(args.source), 'source', ctx);
		if (typeof source === 'string') return toolResult(toolError(source));
		const parsed = parseEditArgs(args, source);
		if (typeof parsed === 'string') return toolResult(toolError(parsed));
		return runMusic(parsed, ctx);
	}
});
