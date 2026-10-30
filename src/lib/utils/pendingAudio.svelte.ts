import { invoke } from '@tauri-apps/api/core';
import type { StoredAudio } from '#lib/ipc/gen/StoredAudio.ts';
import type { AttachedAudio } from '#lib/audio/attached.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';
import { videoOverrides } from '#lib/video/binaries.ts';

export interface PendingAudio extends AttachedAudio {
	id: number;
}

/** What a dropped file is linked to, so the cache's sweep keeps it. */
export interface AudioLink {
	conversationId?: string | null;
	codeSessionId?: string | null;
}

/**
 * Audio files dropped on a composer for its next message, already in the
 * audio cache. Shared by the chat view and the Code composer; the message
 * carries them as `withAttachedAudio` lines. WMA, M4A, AAC and Opus are
 * converted to FLAC with the ffmpeg Settings → Video editing finds.
 */
export function createPendingAudio(link: () => AudioLink) {
	let items = $state<PendingAudio[]>([]);
	let seq = 0;

	async function addPaths(paths: string[]): Promise<void> {
		for (const path of paths) {
			// The file name, not the path: a home directory names the user.
			const name = path.split(/[\\/]/).pop() || 'audio';
			try {
				const { conversationId = null, codeSessionId = null } = link();
				const stored = await invoke<StoredAudio>('audio_store_dropped', {
					path,
					conversationId,
					codeSessionId,
					overrides: videoOverrides()
				});
				items = [...items, { id: seq++, name, hash: stored.hash }];
			} catch (e) {
				console.error('audio_store_dropped failed', name, e);
				showToast(`Couldn't attach ${name}: ${errMessage(e)}`, { kind: 'error' });
			}
		}
	}

	return {
		get items(): PendingAudio[] {
			return items;
		},
		get length(): number {
			return items.length;
		},
		/** The attached files, for `withAttachedAudio`. */
		get audio(): AttachedAudio[] {
			return items.map(({ name, hash }) => ({ name, hash }));
		},
		addPaths,
		/** Replace what's attached (a send the store refused). */
		set(audio: AttachedAudio[]): void {
			items = audio.map((a) => ({ id: seq++, ...a }));
		},
		remove(id: number): void {
			items = items.filter((i) => i.id !== id);
		},
		clear(): void {
			items = [];
		}
	};
}

export type PendingAudioList = ReturnType<typeof createPendingAudio>;
