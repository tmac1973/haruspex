<script lang="ts">
	/**
	 * One camera's ambient log in Settings → Cameras → Activity: its latest 50
	 * entries with their thumbnails, a delete for each, and Clear all. New
	 * entries for the camera appear as they are logged. With camera alerts on,
	 * an Unusual or Urgent entry shows its level and why, and can be dismissed;
	 * the note given then can become one of the camera's watch rules.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import { onDestroy } from 'svelte';
	import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';
	import type { CameraEventNotice } from '#lib/ipc/gen/CameraEventNotice.ts';
	import { stamp } from '#lib/camera/log.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import { getSettings, setCameras } from '#lib/stores/settings.ts';
	import { MAX_WATCH_RULES } from '#lib/camera/alertConfig.ts';

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

	/** The entry whose Dismiss is open, and the note typed for it. */
	let dismissing = $state<number | null>(null);
	let note = $state('');

	function openDismiss(id: number) {
		dismissing = id;
		note = '';
	}

	async function dismiss(e: CameraEvent, addRule: boolean) {
		const text = note.trim();
		try {
			await invoke('camera_event_dismiss', { id: e.id, note: text });
			if (addRule && text) {
				setCameras(
					getSettings().cameras.map((c) =>
						c.id === cameraId && c.alerts.watchRules.length < MAX_WATCH_RULES
							? { ...c, alerts: { ...c.alerts, watchRules: [...c.alerts.watchRules, text] } }
							: c
					)
				);
			}
			events = (events ?? []).map((x) =>
				x.id === e.id ? { ...x, dismissedAt: Date.now(), dismissNote: text } : x
			);
			dismissing = null;
		} catch (err) {
			error = errMessage(err);
		}
	}

	function flagged(e: CameraEvent): boolean {
		return e.alertLevel === 'unusual' || e.alertLevel === 'urgent';
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
		both: 'Motion and sound',
		room: 'Room check'
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
							>{stamp(new Date(e.startedAt))} · {TRIGGERS[e.trigger] ?? e.trigger}
							{#if flagged(e)}<span
									class="chip {e.alertLevel}"
									class:dismissed={e.dismissedAt !== null}
									title={e.dismissedAt !== null ? 'Dismissed' : undefined}
									>{e.alertLevel === 'urgent' ? 'Urgent' : 'Unusual'}</span
								>{/if}</span
						>
						<span class="caption">{caption(e)}</span>
						{#if flagged(e) && e.alertReason}<span class="reason">{e.alertReason}</span>{/if}
						{#if e.transcript.trim()}<span class="said">“{e.transcript.trim()}”</span>{/if}
						{#if dismissing === e.id}
							<div class="dismiss">
								<input
									type="text"
									bind:value={note}
									placeholder="Me cooking late is normal"
									aria-label="Why this is fine"
								/>
								<button type="button" class="btn btn-small" onclick={() => dismiss(e, false)}
									>Dismiss</button
								>
								<button
									type="button"
									class="btn btn-small"
									disabled={!note.trim()}
									title="Saves the note as one of this camera's watch rules, so later entries are judged with it."
									onclick={() => dismiss(e, true)}>Dismiss and add rule</button
								>
							</div>
						{/if}
					</div>
					{#if flagged(e) && e.dismissedAt === null && dismissing !== e.id}
						<button
							type="button"
							class="btn btn-small"
							aria-label={`Dismiss the alert from ${stamp(new Date(e.startedAt))}`}
							onclick={() => openDismiss(e.id)}>Dismiss</button
						>
					{/if}
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

	.chip {
		margin-left: 6px;
		padding: 0 6px;
		border-radius: 8px;
		font-size: 0.75rem;
		font-weight: 600;
	}

	.chip.unusual {
		background: color-mix(in srgb, var(--warning) 14%, transparent);
		color: var(--warning);
	}

	.chip.urgent {
		background: var(--error-bg);
		color: var(--error-text);
	}

	.chip.dismissed {
		opacity: 0.5;
	}

	.reason {
		color: var(--text-secondary);
		font-style: italic;
	}

	.dismiss {
		display: flex;
		gap: 6px;
		margin-top: 4px;
	}

	.dismiss input {
		flex: 1;
		min-width: 0;
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
