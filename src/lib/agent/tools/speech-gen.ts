/**
 * `generate_speech`: text spoken into a WAV, kept in the audio cache and
 * played in the answer, like `generate_music`'s songs. Settings → Audio →
 * Speech engine picks the bundled koko or a llama.cpp `/tts` server, which
 * speaks in a saved voice (`#lib/audio/speak.ts`).
 *
 * Chat and the Code tab only, with someone there. koko streams the audio a
 * sentence at a time and Rust writes it to the file as it comes
 * (`tts_synthesize_to_cache`), so a voiceover of several minutes is no harder
 * than a line. `path` also writes the file into the working folder, checked
 * before koko starts (`_saveGenerated.ts`).
 *
 * `lines` in place of `text` speaks several lines, each in its own voice and
 * into its own file: a scene's character lines for a game, in one call.
 */
import { errMessage } from '#lib/utils/error.ts';
import { speak, speechEngine, type SpeechEngine, type Spoken } from '#lib/audio/speak.ts';
import { savedVoiceNames } from '#lib/audio/savedVoices.ts';
import { getSettings, DEFAULT_TTS_VOICE } from '#lib/stores/settings.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import {
	toolError,
	toolResult,
	type ToolContext,
	type ToolExecOutput
} from '#lib/agent/tools/types.ts';
import {
	isSaveTarget,
	prepareSave,
	writeCached,
	type SaveTarget
} from '#lib/agent/tools/_saveGenerated.ts';
import { savedLineOf } from '#lib/agent/tools/_musicJob.ts';
import { audioSrc } from '#lib/audio/url.ts';
import { TTS_VOICES } from '#lib/audio/voices.ts';
import { trimmed } from '#lib/utils/coerce.ts';

/** About 15 minutes of speech, under the audio cache's 50 MB a file. */
export const MAX_CHARS = 12_000;
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
/** The most `lines` one call speaks. */
export const MAX_LINES = 40;

const VOICE_IDS = TTS_VOICES.map((v) => v.id);

export interface SpeechArgs {
	text: string;
	/** A Kokoro voice id, or a saved voice's name; null for the server's own voice. */
	voice: string | null;
	speed: number;
	/** Another take, on a llama.cpp server. */
	seed: number | null;
	title: string;
	path: string;
	overwrite: boolean;
	notes: string[];
}

/** A title from the text when none was given: its first six words. */
function titleOf(text: string): string {
	const words = text.split(/\s+/).filter(Boolean);
	const head = words
		.slice(0, 6)
		.join(' ')
		.replace(/[.,;:!?]+$/, '');
	return words.length > 6 ? `${head}…` : head;
}

/** The voice for `asked` on `engine`, and a note when it is not the one asked for. */
function voiceFor(
	asked: string,
	engine: SpeechEngine,
	defaultVoice: string
): { voice: string | null; note?: string } {
	if (engine === 'kokoro') {
		const voice = asked || defaultVoice;
		if (VOICE_IDS.includes(voice)) return { voice };
		return {
			voice: DEFAULT_TTS_VOICE,
			note: `There is no voice "${voice}", so it used ${DEFAULT_TTS_VOICE}.`
		};
	}
	if (!asked) return { voice: null };
	const saved = savedVoiceNames().find((n) => n.toLowerCase() === asked.toLowerCase());
	if (saved) return { voice: saved };
	// A Kokoro id means nothing to the server: its own voice it is.
	if (VOICE_IDS.includes(asked)) {
		return { voice: null, note: `${asked} is a Kokoro voice, so it used the server's own voice.` };
	}
	return { voice: asked };
}

/** Parse and clamp the arguments, or say what is wrong. */
export function parseSpeechArgs(
	args: Record<string, unknown>,
	defaultVoice: string,
	engine: SpeechEngine = 'kokoro'
): SpeechArgs | string {
	const text = trimmed(args.text);
	if (!text) return 'generate_speech needs the "text" to speak.';
	if (text.length > MAX_CHARS) {
		return `The text is ${text.length} characters; the most is ${MAX_CHARS}. Split it into parts.`;
	}
	const notes: string[] = [];
	const picked = voiceFor(trimmed(args.voice), engine, defaultVoice);
	if (picked.note) notes.push(picked.note);
	const voice = picked.voice;
	const seed =
		typeof args.seed === 'number' && Number.isInteger(args.seed) && args.seed >= 0
			? args.seed
			: null;
	const asked = typeof args.speed === 'number' && Number.isFinite(args.speed) ? args.speed : 1;
	const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, asked));
	if (speed !== asked) notes.push(`Speed set to ${speed} (${MIN_SPEED}–${MAX_SPEED}).`);
	const path = trimmed(args.path);
	if (path && !/\.wav$/i.test(path)) return 'path must end in .wav.';
	return {
		text,
		voice,
		speed,
		seed,
		title: trimmed(args.title) || titleOf(text),
		path,
		overwrite: args.overwrite === true,
		notes
	};
}

const LINES_SHAPE = 'lines must be a list of {voice, text}.';

/** The file name of `path` without its folder or `.wav`. */
function stemOf(path: string): string {
	return (path.split(/[\\/]/).pop() ?? '').replace(/\.wav$/i, '');
}

/** The `lines` list, also sent as a JSON string, or what is wrong with the call. */
function rawLines(args: Record<string, unknown>): unknown[] | string {
	let raw = args.lines;
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			return LINES_SHAPE;
		}
	}
	if (!Array.isArray(raw) || raw.length === 0) return LINES_SHAPE;
	if (trimmed(args.text)) return 'Give "text" or "lines", not both.';
	if (trimmed(args.path)) return 'With lines, give each line its own path.';
	if (raw.length > MAX_LINES) {
		return `There are ${raw.length} lines; the most is ${MAX_LINES} a call. Split them.`;
	}
	return raw;
}

/**
 * Parse `lines`, one `SpeechArgs` a line, or say what is wrong. A line's
 * voice and speed default to the call's; `seed` and `overwrite` are the
 * call's for every line.
 */
export function parseSpeechLines(
	args: Record<string, unknown>,
	defaultVoice: string,
	engine: SpeechEngine = 'kokoro'
): SpeechArgs[] | string {
	const raw = rawLines(args);
	if (typeof raw === 'string') return raw;
	const parsed: SpeechArgs[] = [];
	const paths = new Map<string, number>();
	let chars = 0;
	for (const [i, item] of raw.entries()) {
		const n = i + 1;
		if (!item || typeof item !== 'object') return `Line ${n} must be {voice, text}.`;
		const line = item as Record<string, unknown>;
		const path = trimmed(line.path);
		const one = parseSpeechArgs(
			{
				text: line.text,
				voice: trimmed(line.voice) || args.voice,
				speed: line.speed ?? args.speed,
				seed: args.seed,
				title: trimmed(line.title) || stemOf(path),
				path,
				overwrite: args.overwrite
			},
			defaultVoice,
			engine
		);
		if (typeof one === 'string') return `Line ${n}: ${one}`;
		if (one.path) {
			const key = one.path.toLowerCase();
			const first = paths.get(key);
			if (first) return `Lines ${first} and ${n} both save to ${one.path}.`;
			paths.set(key, n);
		}
		chars += one.text.length;
		parsed.push(one);
	}
	if (chars > MAX_CHARS) {
		return `The lines are ${chars} characters together; the most is ${MAX_CHARS}. Split them.`;
	}
	return parsed;
}

/** Speech runs about 15 characters a second at normal speed. */
const CHARS_PER_SECOND = 15;

/**
 * A note when the audio is far shorter than the text should take: koko
 * without its phoneme data makes a second of noise for any text.
 */
export function shortNote(text: string, speed: number, seconds: number): string | null {
	const expected = text.length / CHARS_PER_SECOND / speed;
	if (expected < 3 || seconds >= expected * 0.3) return null;
	return `It came out ${Math.round(seconds)} s long, far shorter than this text takes (about ${Math.round(expected)} s): it is probably broken, so tell the user.`;
}

function minutesAndSeconds(sec: number): string {
	const s = Math.round(sec);
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** Speak what `args` asks for and answer with its player line. */
export async function runSpeech(
	args: SpeechArgs,
	ctx: ToolContext,
	progress = 'Speaking'
): Promise<ToolExecOutput> {
	let target: SaveTarget | null = null;
	if (args.path) {
		const settled = await prepareSave(args.path, args.overwrite, ctx, 'generate_speech');
		if (!isSaveTarget(settled)) return settled;
		target = settled;
	}

	ctx.onProgress?.(progress);
	let made: Spoken;
	try {
		made = await speak({
			text: args.text,
			voice: args.voice,
			speed: args.speed,
			seed: args.seed,
			title: args.title,
			conversationId: ctx.conversationId ?? null,
			codeSessionId: ctx.codeSessionId ?? null
		});
	} catch (e) {
		return toolResult(toolError(`Could not make it: ${errMessage(e)}`));
	}
	const url = audioSrc(made.hash) ?? '';

	let saved: string | null = null;
	if (target) {
		const failed = await writeCached(target, { kind: 'audio', hash: made.hash }, ctx);
		saved = savedLineOf(target.path, failed);
	}
	const voice = args.voice ?? "the server's own voice";
	// The server makes a new take each time, so its hash tells two apart.
	const take =
		made.engine === 'llama-server'
			? `, ${made.seconds.toFixed(2)} s, take ${made.hash.slice(0, 12)}`
			: '';
	const lines = [
		`Made "${args.title}" (${minutesAndSeconds(made.seconds)}, voice ${voice}${take}).`,
		`Put ![${args.title}](${url}) in your answer.`,
		...(saved ? [saved] : []),
		...args.notes,
		...(made.note ? [made.note] : []),
		...[shortNote(args.text, args.speed, made.seconds)].filter((n) => n !== null)
	];
	return {
		result: lines.join(' '),
		artifacts: [{ kind: 'audio', mime: made.mime, src: url, title: args.title }]
	};
}

/** The error a `runSpeech` answer carries, or null when it made the line. */
function errorOf(out: ToolExecOutput): string | null {
	if (out.artifacts?.length) return null;
	try {
		const parsed = JSON.parse(out.result) as { error?: unknown };
		return typeof parsed.error === 'string' ? parsed.error : out.result;
	} catch {
		return out.result;
	}
}

/**
 * Speak each line into its own file, one after another. A line that fails
 * doesn't stop the rest; only when none is made is the answer an error.
 */
export async function runSpeechLines(
	lines: SpeechArgs[],
	ctx: ToolContext
): Promise<ToolExecOutput> {
	const said: string[] = [];
	const artifacts: NonNullable<ToolExecOutput['artifacts']> = [];
	let failed = 0;
	for (const [i, line] of lines.entries()) {
		const out = await runSpeech(line, ctx, `Speaking line ${i + 1} of ${lines.length}`);
		const error = errorOf(out);
		if (error) failed++;
		said.push(`Line ${i + 1}: ${error ? `Not made: ${error}` : out.result}`);
		artifacts.push(...(out.artifacts ?? []));
	}
	if (failed === lines.length) return toolResult(toolError(said.join('\n')));
	if (failed) said.push(`${failed} of ${lines.length} lines were not made.`);
	return { result: said.join('\n'), artifacts };
}

const LINE_PROPS = {
	text: { type: 'string', description: 'What this line says.' },
	voice: { type: 'string', description: 'Its voice; default the call\'s "voice".' },
	speed: { type: 'number', description: 'Its speed; default the call\'s "speed".' },
	title: { type: 'string', description: 'A short title; default the file name.' },
	path: {
		type: 'string',
		description: 'Save it here, in the working folder, ending .wav.'
	}
};

registerTool({
	category: 'speech',
	schema: {
		type: 'function',
		function: {
			name: 'generate_speech',
			description:
				'Speak text aloud into an audio file, with a voice on this computer: a voiceover, ' +
				'narration, or lines for a game. Write the text to be heard: plain sentences, numbers ' +
				'and abbreviations as they are said, no markdown.',
			parameters: {
				type: 'object',
				properties: {
					text: {
						type: 'string',
						description: `What to say, up to ${MAX_CHARS} characters. Leave it out when you give lines.`
					},
					lines: {
						type: 'array',
						description: `Instead of text: up to ${MAX_LINES} lines, each spoken into its own file in its own voice, such as a scene's character lines for a game.`,
						items: { type: 'object', properties: LINE_PROPS, required: ['text'] }
					},
					voice: {
						type: 'string',
						description: `With Kokoro: ${VOICE_IDS.join(', ')} (af_/am_ American female/male, ef_/em_ European; default from Settings → Audio). With a llama.cpp speech server: a saved voice's name, or leave it out for the model's own voice.`
					},
					speed: {
						type: 'number',
						description: `${MIN_SPEED} to ${MAX_SPEED}; 1 is normal.`
					},
					seed: {
						type: 'integer',
						description:
							'llama.cpp server only: a different seed makes another take. The same seed does not make the same take again, so keep a take you like.'
					},
					title: { type: 'string', description: 'A short title for the player and the file.' },
					path: {
						type: 'string',
						description: 'Also save it here, in the working folder, ending .wav.'
					},
					overwrite: { type: 'boolean', description: 'Replace an existing file. Default false.' }
				},
				required: []
			}
		}
	},
	displayLabel: (args) => {
		const what =
			args.title ?? args.text ?? (Array.isArray(args.lines) ? `${args.lines.length} lines` : '');
		return `speech: ${String(what).slice(0, 60)}`;
	},
	execute: async (args, ctx) => {
		const voice = getSettings().ttsVoice || DEFAULT_TTS_VOICE;
		if (args.lines !== undefined && args.lines !== null) {
			const lines = parseSpeechLines(args, voice, speechEngine());
			if (typeof lines === 'string') return toolResult(toolError(lines));
			return runSpeechLines(lines, ctx);
		}
		const parsed = parseSpeechArgs(args, voice, speechEngine());
		if (typeof parsed === 'string') return toolResult(toolError(parsed));
		return runSpeech(parsed, ctx);
	}
});
