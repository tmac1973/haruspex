<script lang="ts">
	/**
	 * Settings → Audio → Saved voices: reference clips a llama.cpp speech
	 * server copies a voice from (`voices.rs`). Each can be played, its words
	 * corrected, or deleted. Adding one from a file needs the consent box
	 * ticked under the warning; `voice_from_clip` asks the same in chat.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { open } from '@tauri-apps/plugin-dialog';
	import { onMount } from 'svelte';
	import { errMessage } from '#lib/utils/error.ts';
	import { videoOverrides } from '#lib/video/binaries.ts';
	import { refreshSavedVoices } from '#lib/audio/savedVoices.ts';
	import { VOICE_CONSENT_WARNING, VOICE_CONSENT_YES } from '#lib/audio/voiceConsent.ts';
	import type { SavedVoice } from '#lib/ipc/gen/SavedVoice.ts';

	let voices = $state<SavedVoice[]>([]);
	let error = $state<string | null>(null);
	/** A file picked to add, waiting on a name and the consent box. */
	let adding = $state<{ path: string; name: string; consent: boolean } | null>(null);
	let busy = $state(false);
	/** The voice whose Delete was clicked once, waiting on the second click. */
	let deleting = $state<string | null>(null);
	let playing: HTMLAudioElement | null = null;

	async function reload() {
		voices = await refreshSavedVoices();
	}

	onMount(() => void reload());

	async function pickFile() {
		error = null;
		const path = await open({
			multiple: false,
			directory: false,
			filters: [
				{
					name: 'Sound or video',
					extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'opus', 'mp4', 'mkv', 'mov', 'webm']
				}
			]
		});
		if (typeof path !== 'string') return;
		const base = path.split(/[\\/]/).pop() ?? '';
		adding = { path, name: base.replace(/\.[^.]+$/, ''), consent: false };
	}

	async function add() {
		if (!adding?.consent) return;
		busy = true;
		error = null;
		try {
			await invoke<SavedVoice>('voice_add_file', {
				path: adding.path,
				name: adding.name,
				consent: true,
				overrides: videoOverrides()
			});
			adding = null;
			await reload();
		} catch (e) {
			error = errMessage(e);
		} finally {
			busy = false;
		}
	}

	async function play(v: SavedVoice) {
		playing?.pause();
		try {
			const bytes = await invoke<ArrayBuffer>('voice_read_bytes', { id: v.id });
			const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
			playing = new Audio(url);
			playing.onended = () => URL.revokeObjectURL(url);
			await playing.play();
		} catch (e) {
			error = errMessage(e);
		}
	}

	async function saveText(v: SavedVoice, text: string) {
		if (text.trim() === v.refText) return;
		try {
			await invoke<SavedVoice>('voice_set_ref_text', { id: v.id, refText: text });
			await reload();
		} catch (e) {
			error = errMessage(e);
		}
	}

	async function remove(v: SavedVoice) {
		if (deleting !== v.id) {
			deleting = v.id;
			return;
		}
		deleting = null;
		try {
			await invoke('voice_delete', { id: v.id });
			await reload();
		} catch (e) {
			error = errMessage(e);
		}
	}
</script>

<section class="settings-section">
	<h2>Saved voices</h2>
	<p
		class="help"
		title="A clean 5–10 s of one person speaking is enough; up to 30 s. Used by a llama.cpp speech engine."
	>
		Voices for speech audio files and video narration on a llama.cpp server.
	</p>
	{#each voices as v (v.id)}
		<div class="voice">
			<div class="voice-head">
				<strong>{v.name}</strong>
				<span class="detail">{v.secs.toFixed(1)} s</span>
				<button class="btn btn-small" onclick={() => play(v)}>Play</button>
				<button class="btn btn-small" onclick={() => remove(v)}>
					{deleting === v.id ? 'Delete it' : 'Delete'}
				</button>
			</div>
			<label
				class="detail"
				for="ref-{v.id}"
				title="What the clip says. Correct words copy the voice more closely."
			>
				Words:
			</label>
			<textarea
				id="ref-{v.id}"
				rows="2"
				value={v.refText}
				onblur={(e) => saveText(v, (e.currentTarget as HTMLTextAreaElement).value)}></textarea>
		</div>
	{/each}
	{#if adding}
		<div class="voice adding">
			<div class="detail">{adding.path}</div>
			<label class="name">
				Name: <input type="text" bind:value={adding.name} />
			</label>
			<p class="warning">{VOICE_CONSENT_WARNING}</p>
			<label class="toggle-row">
				<input type="checkbox" bind:checked={adding.consent} />
				<span>{VOICE_CONSENT_YES}</span>
			</label>
			<div class="actions">
				<button
					class="btn btn-small"
					onclick={add}
					disabled={!adding.consent || !adding.name.trim() || busy}
				>
					{busy ? 'Adding…' : 'Add'}
				</button>
				<button class="btn btn-small" onclick={() => (adding = null)} disabled={busy}>
					Cancel
				</button>
			</div>
		</div>
	{:else}
		<div class="actions">
			<button class="btn btn-small" onclick={pickFile}>Add from file…</button>
		</div>
	{/if}
	{#if error}
		<p class="detail bad">{error}</p>
	{/if}
</section>

<style>
	.voice {
		border-top: 1px solid var(--border);
		padding: 8px 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.voice-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.voice-head strong {
		flex: 1;
	}

	textarea,
	.name input {
		width: 100%;
		box-sizing: border-box;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background-color: var(--bg-primary);
		color: var(--text-primary);
		font: inherit;
	}

	.warning {
		margin: 4px 0;
		font-weight: 500;
		color: var(--warning, #b35c00);
	}

	.actions {
		display: flex;
		gap: 8px;
		margin-top: 6px;
	}

	.detail {
		font-size: 0.85em;
		color: var(--text-muted, #888);
		overflow-wrap: anywhere;
	}

	.detail.bad {
		color: var(--error, #c33);
	}
</style>
