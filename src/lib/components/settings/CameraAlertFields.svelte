<script lang="ts">
	/**
	 * A camera's Alerts fields in its Settings → Cameras form: whether its
	 * events are judged, how many people are usually in view, the user's watch
	 * rules and quiet hours (learned from the log, or set here), and the room's
	 * reference pictures (This is normal) for room checks. Edits the form's
	 * draft through `alerts`; the form saves it. References are saved at once,
	 * for a camera already saved.
	 */
	import ImageViewerModal from '#lib/components/ImageViewerModal.svelte';
	import { invoke } from '@tauri-apps/api/core';
	import type { References } from '#lib/ipc/gen/References.ts';
	import type { Light } from '#lib/ipc/gen/Light.ts';
	import { getSettings } from '#lib/stores/settings.ts';
	import { videoOverrides } from '#lib/video/binaries.ts';
	import { stamp } from '#lib/camera/log.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import type { AlertConfig } from '#lib/ipc/gen/AlertConfig.ts';
	import type { QuietHours } from '#lib/ipc/gen/QuietHours.ts';
	import {
		MAX_USUAL_PEOPLE,
		MAX_WATCH_RULE_CHARS,
		MAX_WATCH_RULES
	} from '#lib/camera/alertConfig.ts';
	import { learnQuietHours } from '#lib/camera/judge.ts';

	interface Props {
		cameraId: string;
		alerts: AlertConfig;
	}

	let { cameraId, alerts = $bindable() }: Props = $props();

	let learned = $state<QuietHours | null>(null);
	let refs = $state<References | null>(null);
	let shooting = $state(false);
	let refError = $state('');
	/** The picture shown large, when one is. */
	let viewer = $state<{ src: string; alt: string } | null>(null);

	/** The camera as saved: references need one that works without the form's draft. */
	const saved = $derived(getSettings().cameras.find((c) => c.id === cameraId));

	async function loadRefs() {
		try {
			refs = await invoke<References>('camera_reference_get', { cameraId });
		} catch {
			refs = null;
		}
	}

	$effect(() => {
		if (alerts.enabled && saved && !refs) void loadRefs();
	});

	async function setNormal() {
		if (!saved) return;
		shooting = true;
		refError = '';
		try {
			const overrides = videoOverrides();
			if (saved.ptz !== 'none') {
				await invoke('camera_aim', {
					config: saved,
					aim: { direction: 'home', amount: 'medium' },
					overrides
				});
			}
			const jpeg = await invoke<string>('camera_snapshot', {
				config: saved,
				overrides,
				maxWidth: 1280
			});
			await invoke<Light>('camera_reference_set', { cameraId, jpeg });
			await loadRefs();
		} catch (e) {
			refError = errMessage(e);
		} finally {
			shooting = false;
		}
	}

	async function clearRef(light: Light) {
		try {
			await invoke('camera_reference_clear', { cameraId, light });
			await loadRefs();
		} catch (e) {
			refError = errMessage(e);
		}
	}

	$effect(() => {
		if (!alerts.enabled || learned) return;
		void learnQuietHours(cameraId)
			.then((q) => (learned = q))
			.catch(() => {});
	});

	const shown = $derived(alerts.quietHours ?? learned);
	const editing = $derived(!!alerts.quietHours);

	function addRule() {
		if (alerts.watchRules.length < MAX_WATCH_RULES) alerts.watchRules = [...alerts.watchRules, ''];
	}

	function removeRule(i: number) {
		alerts.watchRules = alerts.watchRules.filter((_, j) => j !== i);
	}

	function editHours() {
		const from = learned ?? { weekday: Array(24).fill(false), weekend: Array(24).fill(false) };
		alerts.quietHours = { weekday: [...from.weekday], weekend: [...from.weekend] };
	}

	function toggleHour(kind: 'weekday' | 'weekend', h: number) {
		if (!alerts.quietHours) return;
		const row = [...alerts.quietHours[kind]];
		row[h] = !row[h];
		alerts.quietHours = { ...alerts.quietHours, [kind]: row };
	}

	function useLearned() {
		const rest = { ...alerts };
		delete rest.quietHours;
		alerts = rest;
	}

	const HOURS = Array.from({ length: 24 }, (_, h) => h);
	const KINDS = [
		{ kind: 'weekday', label: 'Weekdays' },
		{ kind: 'weekend', label: 'Weekends' }
	] as const;
</script>

<span class="label">Alerts</span>
<div class="switch">
	<label
		class="toggle-row"
		title="Each logged entry is judged as normal, unusual or urgent from what is happening, not who it is. Needs a model that can see. Emails go to Settings → Cameras → Alerts."
	>
		<input type="checkbox" bind:checked={alerts.enabled} />
		<span>Judge entries</span>
	</label>
</div>

{#if alerts.enabled}
	<label class="label" for="cam-people-{cameraId}">Usual people</label>
	<input
		id="cam-people-{cameraId}"
		class="people"
		type="number"
		min="0"
		max={MAX_USUAL_PEOPLE}
		bind:value={alerts.usualPeople}
		title="How many people are usually in view at once. More than this is unusual."
	/>

	<span class="label">Watch rules</span>
	<div class="rules">
		{#each Array.from({ length: alerts.watchRules.length }, (_, i) => i) as i (i)}
			<div class="rule">
				<input
					type="text"
					maxlength={MAX_WATCH_RULE_CHARS}
					bind:value={alerts.watchRules[i]}
					placeholder="Tell me if the back door is left open"
					aria-label="Watch rule {i + 1}"
				/>
				<button
					type="button"
					class="btn btn-small"
					aria-label="Remove watch rule {i + 1}"
					onclick={() => removeRule(i)}
				>
					Remove
				</button>
			</div>
		{/each}
		<button
			type="button"
			class="btn btn-small add"
			onclick={addRule}
			disabled={alerts.watchRules.length >= MAX_WATCH_RULES}
			title="Something to be told about, or something that is normal here. A match is urgent unless the rule says otherwise."
		>
			Add rule
		</button>
	</div>

	<span class="label">Room</span>
	<div class="room">
		{#if !saved}
			<p class="hint">Save the camera first.</p>
		{:else}
			<div class="refs">
				{#each [{ light: 'day', label: 'Day' }, { light: 'night', label: 'Night' }] as r (r.light)}
					{@const ref = refs?.[r.light as Light]}
					<div class="ref">
						{#if ref}
							<button
								type="button"
								class="zoom"
								aria-label="Show the {r.label.toLowerCase()} reference larger"
								onclick={() => (viewer = { src: ref.dataUrl, alt: `${r.label} reference` })}
							>
								<img src={ref.dataUrl} alt="{r.label} reference" />
							</button>
							<span class="hint">{r.label} · {stamp(new Date(ref.setAt)).slice(0, 16)}</span>
							<button
								type="button"
								class="btn btn-small"
								aria-label="Clear the {r.label.toLowerCase()} reference"
								onclick={() => clearRef(r.light as Light)}
							>
								Clear
							</button>
						{:else}
							<span class="no-ref" aria-hidden="true"></span>
							<span class="hint">{r.label}: none</span>
						{/if}
					</div>
				{/each}
			</div>
			<button
				type="button"
				class="btn btn-small add"
				onclick={setNormal}
				disabled={shooting}
				title="Takes a picture at the camera's home as the room normally looks. Day and night (infrared) are kept apart; press it again at night, or the first night check sets it. Room checks compare against it a minute after activity and hourly."
			>
				{shooting ? 'Taking…' : 'This is normal'}
			</button>
			{#if saved.ptz !== 'none'}
				<p class="hint">Taken from the camera's home; Set home here changes it.</p>
			{/if}
			{#if refError}<p class="error">{refError}</p>{/if}
		{/if}
	</div>

	<span class="label">Quiet hours</span>
	<div class="quiet">
		{#if shown}
			{#each KINDS as k (k.kind)}
				<div class="row" role="group" aria-label="{k.label} quiet hours">
					<span class="kind">{k.label}</span>
					{#each HOURS as h (h)}
						<button
							type="button"
							class="hour"
							class:on={shown[k.kind][h]}
							disabled={!editing}
							aria-pressed={shown[k.kind][h]}
							aria-label="{k.label} {h}:00"
							title="{String(h).padStart(2, '0')}:00"
							onclick={() => toggleHour(k.kind, h)}
						></button>
					{/each}
				</div>
			{/each}
		{/if}
		<div class="quiet-actions">
			{#if editing}
				<button type="button" class="btn btn-small" onclick={useLearned}>Use learned</button>
			{:else}
				<button
					type="button"
					class="btn btn-small"
					aria-label="Edit quiet hours"
					onclick={editHours}
					title="Learned from the last 14 days of this camera's log, once it has a week of entries. Anyone about in a quiet hour is unusual."
				>
					Edit
				</button>
			{/if}
		</div>
	</div>
{/if}

<ImageViewerModal src={viewer?.src ?? null} alt={viewer?.alt} onClose={() => (viewer = null)} />

<style>
	.zoom {
		padding: 0;
		border: none;
		background: none;
		cursor: zoom-in;
		line-height: 0;
		flex: none;
	}

	/* The form's grid: labels and inputs as in CameraForm. */
	.label {
		padding-top: 6px;
		color: var(--text-secondary);
	}

	.switch {
		padding-top: 4px;
	}

	input:not([type='checkbox']) {
		box-sizing: border-box;
	}

	.people {
		width: 5rem;
	}

	.rules,
	.quiet {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	.rule {
		display: flex;
		gap: 6px;
	}

	.rule input {
		flex: 1;
		min-width: 0;
	}

	.add,
	.quiet-actions {
		align-self: flex-start;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 2px;
		flex-wrap: wrap;
	}

	.kind {
		width: 5.5rem;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.hour {
		width: 12px;
		height: 16px;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 2px;
		background: var(--bg-secondary);
	}

	.hour.on {
		background: var(--accent);
		border-color: var(--accent);
	}

	.hour:disabled {
		cursor: default;
	}

	.room {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	.refs {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
	}

	.ref {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}

	.ref img,
	.no-ref {
		width: 128px;
		height: 72px;
		object-fit: cover;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
	}

	.hint {
		margin: 0;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.error {
		margin: 0;
		color: var(--error-text);
		font-size: 0.8rem;
		overflow-wrap: anywhere;
	}
</style>
