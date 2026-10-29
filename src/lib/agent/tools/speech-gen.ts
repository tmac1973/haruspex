/**
 * `generate_speech`: text spoken into a WAV by the bundled koko, kept in the
 * audio cache and played in the answer, like `generate_music`'s songs.
 *
 * Chat and the Code tab only, with someone there. koko streams the audio a
 * sentence at a time and Rust writes it to the file as it comes
 * (`tts_synthesize_to_cache`), so a voiceover of several minutes is no harder
 * than a line. `path` also writes the file into the working folder, checked
 * before koko starts (`_saveGenerated.ts`).
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
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
import type { StoredSpeech } from '#lib/ipc/gen/StoredSpeech.ts';

/** About 15 minutes of speech, under the audio cache's 50 MB a file. */
export const MAX_CHARS = 12_000;
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

const VOICE_IDS = TTS_VOICES.map((v) => v.id);

export interface SpeechArgs {
	text: string;
	voice: string;
	speed: number;
	title: string;
	path: string;
	overwrite: boolean;
	notes: string[];
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A title from the text when none was given: its first six words. */
function titleOf(text: string): string {
	const words = text.split(/\s+/).filter(Boolean);
	const head = words
		.slice(0, 6)
		.join(' ')
		.replace(/[.,;:!?]+$/, '');
	return words.length > 6 ? `${head}…` : head;
}

/** Parse and clamp the arguments, or say what is wrong. */
export function parseSpeechArgs(
	args: Record<string, unknown>,
	defaultVoice: string
): SpeechArgs | string {
	const text = str(args.text);
	if (!text) return 'generate_speech needs the "text" to speak.';
	if (text.length > MAX_CHARS) {
		return `The text is ${text.length} characters; the most is ${MAX_CHARS}. Split it into parts.`;
	}
	const notes: string[] = [];
	let voice = str(args.voice) || defaultVoice;
	if (!VOICE_IDS.includes(voice)) {
		notes.push(`There is no voice "${voice}", so it used ${DEFAULT_TTS_VOICE}.`);
		voice = DEFAULT_TTS_VOICE;
	}
	const asked = typeof args.speed === 'number' && Number.isFinite(args.speed) ? args.speed : 1;
	const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, asked));
	if (speed !== asked) notes.push(`Speed set to ${speed} (${MIN_SPEED}–${MAX_SPEED}).`);
	const path = str(args.path);
	if (path && !/\.wav$/i.test(path)) return 'path must end in .wav.';
	return {
		text,
		voice,
		speed,
		title: str(args.title) || titleOf(text),
		path,
		overwrite: args.overwrite === true,
		notes
	};
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
	let made: StoredSpeech;
	try {
		made = await invoke<StoredSpeech>('tts_synthesize_to_cache', {
			text: args.text,
			voice: args.voice,
			speed: args.speed,
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
	const lines = [
		`Made "${args.title}" (${minutesAndSeconds(made.seconds)}, voice ${args.voice}).`,
		`Put ![${args.title}](${url}) in your answer.`,
		...(saved ? [saved] : []),
		...args.notes
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
						enum: VOICE_IDS,
						description:
							'af_/am_ are American female/male, ef_/em_ European. Default from Settings → Audio.'
					},
					speed: {
						type: 'number',
						description: `${MIN_SPEED} to ${MAX_SPEED}; 1 is normal.`
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
		const parsed = parseSpeechArgs(args, getSettings().ttsVoice || DEFAULT_TTS_VOICE);
		if (typeof parsed === 'string') return toolResult(toolError(parsed));
		return runSpeech(parsed, ctx);
	}
});
