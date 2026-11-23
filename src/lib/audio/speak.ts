/**
 * Speech into the audio cache with the engine Settings → Audio → Speech
 * engine picks: the bundled Kokoro, or a llama.cpp `/tts` server that can
 * copy a saved voice. `generate_speech` and a video sequence's narration
 * both come here; reading answers aloud does not (it is always Kokoro).
 *
 * The server can't change pace (Qwen3-TTS refuses any speed but 1), so a
 * speed other than 1 is applied after with `audio_stretch`, pitch kept.
 */
import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '#lib/stores/settings.ts';
import { toolchestKeyFor } from '#lib/toolchest/models.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import type { ServerSpeech } from '#lib/ipc/gen/ServerSpeech.ts';
import type { StoredSpeech } from '#lib/ipc/gen/StoredSpeech.ts';

export type SpeechEngine = 'kokoro' | 'llama-server';

export interface SpeakRequest {
	text: string;
	/** A Kokoro voice id, or a saved voice's name; null for the engine's default. */
	voice: string | null;
	/** 1 is normal. */
	speed: number;
	/** A llama.cpp server only: another take. */
	seed?: number | null;
	title?: string | null;
	conversationId?: string | null;
	codeSessionId?: string | null;
}

export interface Spoken {
	/** The SHA-256 of the WAV, its name in the audio cache. */
	hash: string;
	mime: string;
	seconds: number;
	engine: SpeechEngine;
	/** Said when something was dropped on the way. */
	note: string | null;
}

/** The engine `generate_speech` and narration use now. */
export function speechEngine(): SpeechEngine {
	return getSettings().speechBackendKind === 'llama-server' ? 'llama-server' : 'kokoro';
}

function keep(req: SpeakRequest) {
	return {
		title: req.title ?? null,
		conversationId: req.conversationId ?? null,
		codeSessionId: req.codeSessionId ?? null
	};
}

async function onServer(req: SpeakRequest): Promise<Spoken> {
	const s = getSettings();
	if (!s.speechServerModelId.trim()) {
		throw new Error('No speech model is chosen — Settings → Audio → Speech engine.');
	}
	const made = await invoke<ServerSpeech>('speech_server_synthesize', {
		baseUrl: s.speechServerBaseUrl,
		apiKey: (await toolchestKeyFor(s.speechServerApiKeyId)) || null,
		model: s.speechServerModelId,
		text: req.text,
		voice: req.voice,
		seed: req.seed ?? null,
		temperature: null,
		...keep(req)
	});
	let spoken: Spoken = { ...made, engine: 'llama-server', note: made.note };
	if (Math.abs(req.speed - 1) > 0.001) {
		const stretched = await invoke<StoredSpeech>('audio_stretch', {
			hash: made.hash,
			factor: req.speed,
			...keep(req),
			overrides: videoOverrides()
		});
		spoken = { ...spoken, ...stretched };
	}
	return spoken;
}

/** Speak `req` with the chosen engine into the audio cache. */
export async function speak(req: SpeakRequest): Promise<Spoken> {
	if (speechEngine() === 'llama-server') return onServer(req);
	const made = await invoke<StoredSpeech>('tts_synthesize_to_cache', {
		text: req.text,
		voice: req.voice ?? getSettings().ttsVoice,
		speed: req.speed,
		...keep(req)
	});
	return { ...made, engine: 'kokoro', note: null };
}
