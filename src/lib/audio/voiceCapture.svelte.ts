/**
 * Shared voice capture state: push-to-talk and constant listening.
 *
 * Both the on-screen MicButton (hold the button to record, or right-click
 * for constant listening) and the global F2 push-to-talk hotkey go through
 * this module so the Rust side's microphone never gets double-started.
 * State is reactive so any subscriber (button, status indicator) re-renders
 * when capture starts / stops.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { sleep } from '#lib/utils/async.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import type { SidecarStatus } from '#lib/ipc/gen/SidecarStatus.ts';
import type { ListenEvent } from '#lib/ipc/gen/ListenEvent.ts';
import { errMessage } from '#lib/utils/error.ts';
import { appendPhrase, parseDictation, removeAppended } from '#lib/audio/dictation.ts';

export type VoiceCaptureStatus =
	'idle' | 'recording' | 'processing' | 'downloading' | 'listening' | 'paused';

let status = $state<VoiceCaptureStatus>('idle');
/** Phrases heard but not yet transcribed, while constant listening. */
let pendingPhrases = $state(0);

/** The composer constant listening dictates into. */
export interface DictationTarget {
	getText(): string;
	setText(text: string): void;
	/** Send the composer; false when it can't right now. */
	send(): Promise<boolean>;
}

// The constant listening session this window started, if any.
let session: number | null = null;
let owner: symbol | null = null;
let target: DictationTarget | null = null;
/** Exactly what the last phrase added, for "scratch that". */
let lastSuffix: string | null = null;
let listening: Promise<unknown> | null = null;
let queue: Promise<void> = Promise.resolve();

/**
 * Every capture/transcription failure surfaces as an error toast — the old
 * inline MicButton error span clipped messages at 200px, truncating exactly
 * the errors ("Download whisper model first") the user needed to read.
 */
function toastError(message: string): void {
	showToast(message, { kind: 'error' });
}

export function getVoiceCaptureStatus(): VoiceCaptureStatus {
	return status;
}

export function isVoiceCaptureActive(): boolean {
	return status === 'recording';
}

export function getPendingPhrases(): number {
	return pendingPhrases;
}

/** Whether the MicButton holding `token` started the current constant listening. */
export function isListeningOwner(token: symbol): boolean {
	return session !== null && owner === token;
}

function resetListening(): void {
	session = null;
	owner = null;
	target = null;
	lastSuffix = null;
	pendingPhrases = 0;
	status = 'idle';
}

/**
 * Start constant listening into `dictationTarget`, owned by the MicButton
 * holding `ownerToken`. Gets whisper ready (downloading the model the first
 * time) before opening the mic.
 */
export async function startListening(
	ownerToken: symbol,
	dictationTarget: DictationTarget
): Promise<void> {
	if (status !== 'idle') return;
	status = 'processing';
	// One event at a time, so a slow send can't race the next phrase.
	listening ??= listen<ListenEvent>('voice://listen', (e) => {
		queue = queue
			.then(() => onListenEvent(e.payload))
			.catch((err: unknown) => {
				console.warn('Constant listening event failed:', err);
			});
	});
	await listening;
	if (!(await ensureWhisperReady())) {
		toastError('Speech recognition not available.');
		status = 'idle';
		return;
	}
	try {
		const deviceName = getSettings().audioInputDevice || undefined;
		session = await invoke<number>('voice_listen_start', { deviceName });
		owner = ownerToken;
		target = dictationTarget;
		lastSuffix = null;
		pendingPhrases = 0;
		status = 'listening';
		if (playingMedia.size > 0) sendHold(true);
	} catch (e) {
		toastError(`Mic error: ${errMessage(e)}`);
		resetListening();
	}
}

/** Stop constant listening. Does nothing when this window isn't listening. */
export async function stopListening(): Promise<void> {
	if (session === null) return;
	resetListening();
	try {
		await invoke('voice_listen_stop');
	} catch (e) {
		console.warn('Stopping constant listening failed:', e);
	}
}

/** Which composer constant listening started from Shift+F2 dictates into. */
export type DictationSurface = 'chat' | 'shell' | 'code';

interface RegisteredTarget {
	surface: DictationSurface;
	/** The conversation or session the composer is for, read when Shift+F2 picks one. */
	key: () => string | undefined;
	target: DictationTarget;
}

// Every mounted composer, by its MicButton's token. Code and Shell keep a
// pane mounted per session, so several can share a surface.
// Not reactive on purpose: only Shift+F2 reads it.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const targets = new Map<symbol, RegisteredTarget>();

/** Offer a mounted composer to Shift+F2; the returned function takes it back. */
export function registerDictationTarget(token: symbol, entry: RegisteredTarget): () => void {
	targets.set(token, entry);
	return () => {
		targets.delete(token);
	};
}

/**
 * Shift+F2: stop listening, or start it into the composer for `surface`,
 * and for session `key` when the tab has several (Code, Shell).
 */
export async function toggleListeningFor(surface: DictationSurface, key?: string): Promise<void> {
	if (status === 'listening' || status === 'paused') {
		await stopListening();
		return;
	}
	let found: [symbol, RegisteredTarget] | undefined;
	for (const pair of targets) {
		if (pair[1].surface === surface && (key === undefined || pair[1].key() === key)) found = pair;
	}
	if (!found) {
		showToast('No composer to dictate into here');
		return;
	}
	await startListening(found[0], found[1].target);
}

// Audio or video playing in the page (generated speech, songs, previews):
// listening holds while any of it is audible, as it does for read-aloud.
// Not reactive on purpose: only the hold logic reads it.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const playingMedia = new Set<HTMLMediaElement>();

function sendHold(hold: boolean): void {
	if (session === null) return;
	void invoke('voice_listen_hold', { hold }).catch((e: unknown) => {
		console.warn('Holding constant listening failed:', e);
	});
}

function onMediaEvent(e: Event): void {
	const el = e.target;
	if (!(el instanceof HTMLMediaElement)) return;
	const wasPlaying = playingMedia.size > 0;
	if (!el.paused && !el.ended && !el.muted && el.volume > 0) playingMedia.add(el);
	else playingMedia.delete(el);
	const isPlaying = playingMedia.size > 0;
	if (isPlaying !== wasPlaying) sendHold(isPlaying);
}

const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied', 'volumechange'];

/** Hold constant listening while the page plays sound; returns the remover. */
export function installMediaHold(doc: Document): () => void {
	// Media events don't bubble, so listen in the capture phase.
	for (const name of MEDIA_EVENTS) doc.addEventListener(name, onMediaEvent, true);
	return () => {
		for (const name of MEDIA_EVENTS) doc.removeEventListener(name, onMediaEvent, true);
		playingMedia.clear();
	};
}

async function onPhrase(text: string): Promise<void> {
	const t = target;
	if (!t) return;
	const d = parseDictation(text);
	if (d.kind === 'none') return;
	if (d.kind === 'scratch') {
		const back = lastSuffix ? removeAppended(t.getText(), lastSuffix) : null;
		if (back === null) {
			showToast('Nothing to scratch');
			return;
		}
		t.setText(back);
		lastSuffix = null;
		return;
	}
	if (d.text) {
		const next = appendPhrase(t.getText(), d.text);
		t.setText(next.text);
		lastSuffix = next.suffix;
	}
	if (d.kind === 'send') {
		if (await t.send()) lastSuffix = null;
		else showToast('Couldn’t send yet — say “send it” again');
	}
}

async function onListenEvent(e: ListenEvent): Promise<void> {
	if (session === null || e.session !== session) return;
	switch (e.type) {
		case 'Paused':
			status = e.paused ? 'paused' : 'listening';
			break;
		case 'PhraseQueued':
			pendingPhrases++;
			break;
		case 'Phrase':
			pendingPhrases = Math.max(0, pendingPhrases - 1);
			await onPhrase(e.text);
			break;
		case 'Error':
			toastError(`Transcription failed: ${e.message}`);
			break;
		case 'Stopped':
			resetListening();
			if (e.reason === 'Idle') showToast('Constant listening stopped after 5 minutes of silence');
			else if (e.reason === 'Device')
				toastError('Microphone disconnected — constant listening stopped');
			break;
	}
}

export async function startVoiceCapture(): Promise<void> {
	if (status !== 'idle') return;
	try {
		const deviceName = getSettings().audioInputDevice || undefined;
		await invoke('start_recording', { deviceName });
		status = 'recording';
	} catch (e) {
		toastError(`Mic error: ${errMessage(e)}`);
	}
}

/**
 * Abort the in-flight recording without transcribing — the audio is
 * discarded. Used when the user backs out of a push-to-talk gesture
 * (Esc, focus loss, or the pointer leaving the mic button).
 */
export async function cancelVoiceCapture(): Promise<void> {
	if (status !== 'recording') return;
	try {
		await invoke('stop_recording');
	} catch {
		// Best-effort abort — the recording singleton resets either way.
	}
	status = 'idle';
}

/**
 * Stop the in-flight recording and return the transcribed text. Resolves
 * to null on no-speech-detected, whisper download failure, or any other
 * error path — the reason surfaces as an error toast.
 */
export async function stopAndTranscribe(): Promise<string | null> {
	if (status !== 'recording') return null;
	status = 'processing';
	try {
		const audioData = await invoke<number[]>('stop_recording');
		const ready = await ensureWhisperReady();
		if (!ready) {
			toastError('Speech recognition not available. Download whisper model first.');
			status = 'idle';
			return null;
		}
		const text = await invoke<string>('transcribe_audio', { audio: audioData });
		status = 'idle';
		const trimmed = text?.trim() ?? '';
		if (!trimmed) {
			toastError('No speech detected');
			return null;
		}
		return trimmed;
	} catch (e) {
		toastError(`Transcription failed: ${e}`);
		status = 'idle';
		return null;
	}
}

/**
 * The whisper model voice input uses, per Settings → Audio → Speech model,
 * downloading it the first time. large-v3-turbo is the file the video tools
 * use, so it is fetched once for both.
 */
async function speechModelPath(): Promise<string> {
	const turbo = getSettings().speechModel === 'large-v3-turbo';
	const existing = await invoke<string | null>(
		turbo ? 'whisper_video_model_path' : 'get_whisper_model_path'
	);
	if (existing) return existing;
	const before = status;
	status = 'downloading';
	try {
		return await invoke<string>(turbo ? 'whisper_video_model_download' : 'download_whisper_model');
	} finally {
		status = before;
	}
}

/**
 * Silero VAD for whisper-server, so silence transcribes as nothing instead of
 * made-up words. Optional: voice input works without it.
 */
async function vadModelPath(): Promise<string | null> {
	try {
		const existing = await invoke<string | null>('whisper_vad_model_path');
		if (existing) return existing;
		const before = status;
		status = 'downloading';
		try {
			return await invoke<string>('whisper_vad_model_download');
		} finally {
			status = before;
		}
	} catch (e) {
		console.warn('Speech detector unavailable, transcribing without it:', e);
		return null;
	}
}

/**
 * Get whisper-server running on the chosen model. `start_whisper` leaves a
 * server that is already Ready on the same model alone, and restarts it when
 * the setting changed.
 */
export async function ensureWhisperReady(): Promise<boolean> {
	let modelPath: string;
	try {
		modelPath = await speechModelPath();
	} catch (e) {
		toastError(`Whisper model download failed: ${e}`);
		return false;
	}
	try {
		const vadPath = await vadModelPath();
		await invoke('start_whisper', { modelPath, vadModelPath: vadPath });
		for (let i = 0; i < 30; i++) {
			const next = await invoke<SidecarStatus>('get_whisper_status');
			if (next.type === 'Ready') return true;
			if (next.type === 'Error') return false;
			await sleep(500);
		}
		return false;
	} catch (e) {
		console.error('Whisper setup failed:', e);
		return false;
	}
}
