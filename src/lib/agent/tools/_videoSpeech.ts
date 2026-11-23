/**
 * `generate_video`'s speech, for an instance that makes someone speak
 * (Wan2.2 S2V, the `audio` capability): the sound file or the speech made in
 * the conversation, kept in the audio cache, and checked against the longest
 * clip the instance makes before anything is uploaded.
 */
import { invoke } from '@tauri-apps/api/core';
import type { ToolContext } from '#lib/agent/tools/types.ts';
import type { ToolchestInstance } from '#lib/toolchest/models.ts';
import type { StoredAudio } from '#lib/ipc/gen/StoredAudio.ts';
import type { ClipInfo } from '#lib/ipc/gen/ClipInfo.ts';
import { audioHashFromUrl } from '#lib/audio/url.ts';
import { videoSettings } from '#lib/video/args.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import { maxClipFrames } from '#lib/videogen/fit.ts';
import { trimmed } from '#lib/utils/coerce.ts';
import { errMessage } from '#lib/utils/error.ts';

export const speaks = (i: ToolchestInstance) => i.capabilities.includes('audio');

/** Why the call can't go to `instance` as it is, or null. */
export function speechRefusal(
	args: Record<string, unknown>,
	instance: ToolchestInstance
): string | null {
	const audio = trimmed(args.audio);
	if (audio && !speaks(instance)) {
		return `${instance.id} can't make someone speak; that needs a video instance with the audio capability (Wan2.2 S2V).`;
	}
	if (speaks(instance) && (!audio || !trimmed(args.start_image))) {
		return `${instance.id} makes a person in a picture speak: give start_image (the person) and audio (the speech).`;
	}
	return null;
}

export interface Speech {
	hash: string;
	name: string;
	secs: number;
}

/** The speech `args.audio` names, in the audio cache, with its length. Or why not. */
export async function keptSpeech(
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<Speech | string> {
	const value = trimmed(args.audio);
	try {
		let hash = audioHashFromUrl(value) ?? (/^[0-9a-f]{64}$/.test(value) ? value : null);
		let name = 'speech.wav';
		if (!hash) {
			if (!ctx.workingDir)
				return 'audio must be speech made in this conversation, or a file in the working folder.';
			const stored = await invoke<StoredAudio>('audio_cache_import', {
				workingDir: ctx.workingDir,
				path: value,
				conversationId: ctx.conversationId ?? null,
				codeSessionId: ctx.codeSessionId ?? null,
				overrides: videoOverrides()
			});
			hash = stored.hash;
			name = value.split(/[\\/]/).pop() || name;
		}
		const info = await invoke<ClipInfo>('video_probe_cached', { hash, settings: videoSettings() });
		if (!info.audio.length) return `${value} has no sound.`;
		return { hash, name, secs: info.durationSecs };
	} catch (e) {
		return `Could not read the speech: ${errMessage(e)}`;
	}
}

/** Why the speech is too long for one clip of `width`×`height`, or null. */
export function speechTooLong(
	speech: Speech,
	instance: ToolchestInstance,
	size: { width: number; height: number; fps: number }
): string | null {
	if (!instance.video) return null;
	const cap = maxClipFrames(instance.video, size.width, size.height);
	if (!Number.isFinite(cap)) return null;
	const most = cap / size.fps;
	if (speech.secs <= most + 0.05) return null;
	return `The speech is ${speech.secs.toFixed(1)} s; ${instance.id} makes at most ${most.toFixed(1)} s at ${size.width}×${size.height}. Split the speech at its pauses and make one clip for each part.`;
}
