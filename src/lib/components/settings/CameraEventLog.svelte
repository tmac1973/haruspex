<script lang="ts">
	/**
	 * One camera's ambient log in Settings → Cameras → Activity: its latest 50
	 * entries with their thumbnails, a delete for each, and Clear all. New
	 * entries for the camera appear as they are logged.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import { onDestroy } from 'svelte';
	import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';
	import type { CameraEventNotice } from '#lib/ipc/gen/CameraEventNotice.ts';
	import { stamp } from '#lib/camera/log.ts';
	import { errMessage } from '#lib/utils/error.ts';

	interface Props {
		cameraId: string;
		cameraName: string;
	}

	let { cameraId, cameraName }: Props = $props();

	/** Entries shown. */
	const LIMIT = 50;

	let events = $state<CameraEvent[] | null>(null);
	let thumbs = $state<Record<number, string>>({});
	let error = $state('');

	async function load() {
		try {
			events = await invoke<CameraEvent[]>('camera_events_list', { cameraId, limit: LIMIT });
			error = '';
			for (const e of events) {
				if (e.hasThumb && !(e.id in thumbs)) void loadThumb(e.id);
			}
		} catch (e) {
			error = errMessage(e);
		}
	}

	async function loadThumb(id: number) {
		try {
			const url = await invoke<string>('camera_event_thumb', { id });
			thumbs = { ...thumbs, [id]: url };
		} catch {
			// Shown without a picture.
		}
	}

	async function remove(id: number) {
		try {
			await invoke('camera_event_delete', { id });
			events = (events ?? []).filter((e) => e.id !== id);
		} catch (e) {
			error = errMessage(e);
		}
	}

	async function clearAll() {
		if (!confirm(`Delete every entry in ${cameraName}'s log? This can't be undone.`)) return;
		try {
			await invoke('camera_events_clear', { cameraId });
			events = [];
			thumbs = {};
		} catch (e) {
			error = errMessage(e);
		}
	}

	void load();

	let stop: (() => void) | null = null;
	let gone = false;
	void listen<CameraEventNotice>('camera://event', (e) => {
		if (e.payload.cameraId === cameraId) void load();
	})
		.then((unlisten) => {
			if (gone) unlisten();
			else stop = unlisten;
		})
		.catch(() => {});
	onDestroy(() => {
		gone = true;
		stop?.();
	});

	function caption(e: CameraEvent): string {
		if (e.captionStatus === 'done' && e.caption) return e.caption;
		return e.captionStatus === 'pending' ? 'Caption pending.' : 'No caption.';
	}

	const TRIGGERS: Record<string, string> = {
		motion: 'Motion',
		sound: 'Sound',
		both: 'Motion and sound'
	};
</script>

<div class="log">
	{#if error}<p class="error">{error}</p>{/if}
	{#if events && events.length === 0}
		<p class="help">No entries.</p>
	{:else if events}
		<ul aria-label={`${cameraName} activity`}>
			{#each events as e (e.id)}
				<li>
					{#if thumbs[e.id]}
						<img src={thumbs[e.id]} alt="" />
					{:else}
						<span class="no-thumb" aria-hidden="true"></span>
					{/if}
					<div class="text">
						<span class="meta"
							>{stamp(new Date(e.startedAt))} · {TRIGGERS[e.trigger] ?? e.trigger}</span
						>
						<span class="caption">{caption(e)}</span>
						{#if e.transcript.trim()}<span class="said">“{e.transcript.trim()}”</span>{/if}
					</div>
					<button
						type="button"
						class="btn btn-small"
						aria-label={`Delete the entry from ${stamp(new Date(e.startedAt))}`}
						onclick={() => remove(e.id)}>Delete</button
					>
				</li>
			{/each}
		</ul>
		<div class="actions">
			<button
				type="button"
				class="btn btn-small"
				title={`Deletes every entry in ${cameraName}'s log, with its pictures.`}
				onclick={clearAll}>Clear all</button
			>
		</div>
	{/if}
</div>

<style>
	.log {
		font-size: 0.85rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-height: 24rem;
		overflow-y: auto;
	}

	li {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}

	img,
	.no-thumb {
		width: 96px;
		height: 54px;
		flex: none;
		object-fit: cover;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
	}

	.text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		overflow-wrap: anywhere;
	}

	.meta {
		color: var(--text-muted);
		font-size: 0.8rem;
	}

	.said {
		color: var(--text-secondary);
	}

	.help {
		margin: 0;
		color: var(--text-secondary);
	}

	.error {
		margin: 0 0 6px;
		color: var(--error-text);
		overflow-wrap: anywhere;
	}

	.actions {
		margin-top: 8px;
	}
</style>
