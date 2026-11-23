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
 */
import { invoke } from '@tauri-apps/api/core';
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
	writeSaved,
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
export async function runSpeech(args: SpeechArgs, ctx: ToolContext): Promise<ToolExecOutput> {
	let target: SaveTarget | null = null;
	if (args.path) {
		const settled = await prepareSave(args.path, args.overwrite, ctx, 'generate_speech');
		if (!isSaveTarget(settled)) return settled;
		target = settled;
	}

	ctx.onProgress?.('Speaking');
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
		const bytes = new Uint8Array(
			await invoke<ArrayBuffer>('audio_read_bytes', { hash: made.hash })
		);
		saved = savedLineOf(target.path, await writeSaved(target, bytes, ctx));
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
						description: `What to say, up to ${MAX_CHARS} characters.`
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
				required: ['text']
			}
		}
	},
	displayLabel: (args) => `speech: ${String(args.title ?? args.text ?? '').slice(0, 60)}`,
	execute: async (args, ctx) => {
		const parsed = parseSpeechArgs(
			args,
			getSettings().ttsVoice || DEFAULT_TTS_VOICE,
			speechEngine()
		);
		if (typeof parsed === 'string') return toolResult(toolError(parsed));
		return runSpeech(parsed, ctx);
	}
});
