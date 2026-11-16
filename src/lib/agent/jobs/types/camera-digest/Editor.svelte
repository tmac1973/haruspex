<script lang="ts">
	// The camera digest's section of the job editor (see JobTypeEditorProps).
	import Tooltip from '#lib/components/Tooltip.svelte';
	import { getSettings } from '#lib/stores/settings.ts';
	import { backendOverrideFor } from '#lib/agent/jobs/jobBackend.ts';
	import { modelColumnsFromForm, type JobModelForm } from '#lib/agent/jobs/jobModelForm.ts';
	import {
		FOCUS_MAX,
		NEEDS,
		cameraDigestUsable,
		type CameraDigestConfig
	} from '#lib/agent/jobs/types/camera-digest/config.ts';

	let {
		config = $bindable(),
		jobModel
	}: { config: Record<string, unknown>; jobModel?: JobModelForm } = $props();

	const cfg = config as unknown as CameraDigestConfig;
	const cameras = getSettings().cameras;

	const usable = $derived(
		cameraDigestUsable(jobModel ? backendOverrideFor(modelColumnsFromForm(jobModel)) : undefined)
	);

	function toggle(id: string, on: boolean) {
		cfg.cameras = on ? [...cfg.cameras, id] : cfg.cameras.filter((c) => c !== id);
	}
</script>

{#if !usable}
	<p class="needs" role="status">{NEEDS}</p>
{/if}

<fieldset class="field cameras">
	<legend class="label">
		Cameras
		<Tooltip
			label="About the cameras"
			text="The digest reads these cameras' ambient logs. None ticked reads every camera set to Allow. Jobs can't use a camera set to Ask; change it in Settings → Cameras."
		/>
	</legend>
	{#if cameras.length === 0}
		<p class="hint">No cameras yet. Add one in Settings → Cameras.</p>
	{:else}
		<div class="list">
			{#each cameras as camera (camera.id)}
				{@const ask = camera.permission !== 'allow'}
				{@const on = cfg.cameras.includes(camera.id)}
				<label
					class="check"
					class:ask
					title={ask ? 'Set to Ask: jobs can’t use it. Settings → Cameras sets Allow.' : undefined}
				>
					<input
						type="checkbox"
						checked={on}
						disabled={ask && !on}
						onchange={(e) => toggle(camera.id, (e.currentTarget as HTMLInputElement).checked)}
					/>
					{camera.name}{ask ? ' (Ask)' : ''}
				</label>
			{/each}
		</div>
	{/if}
</fieldset>

<label class="field">
	<span class="label">
		Period
		<Tooltip
			label="About the period"
			text="Since the last run reads from when this job last finished a run, or the last 24 hours on its first."
		/>
	</span>
	<select bind:value={cfg.period} aria-label="Period">
		<option value="since_last_run">Since the last run</option>
		<option value="last_24h">Last 24 hours</option>
		<option value="today">Today</option>
	</select>
</label>

<div class="toggle-row">
	<label>
		<input type="checkbox" bind:checked={cfg.include_snapshot} />
		<span class="label">
			Include a snapshot
			<Tooltip
				label="About the snapshot"
				text="Takes a fresh picture from each camera for the summary. Needs a model that can see images; without one it is skipped."
			/>
		</span>
	</label>
</div>

<label class="field">
	<span class="label">
		Focus
		<Tooltip
			label="About the focus"
			text="Optional. What the summary should pay attention to, in your words."
		/>
	</span>
	<input
		type="text"
		bind:value={cfg.focus}
		maxlength={FOCUS_MAX}
		placeholder="Only mention people and deliveries"
	/>
</label>

<style>
	.label {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.needs {
		margin: 0;
		font-size: 0.85rem;
		color: var(--warning);
	}

	.cameras {
		border: none;
		margin: 0;
		padding: 0;
	}

	.list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 155px;
		overflow-y: auto;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
	}

	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.88rem;
	}

	.check.ask {
		color: var(--text-muted);
	}

	.hint {
		font-style: italic;
	}
</style>
