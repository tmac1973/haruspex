<script lang="ts">
	/** Settings → General → Keep the computer awake (`agent/jobs/keepAwake.ts`). */
	import { getJobKeepAwake, updateSettings, type JobKeepAwake } from '#lib/stores/settings.ts';

	const value = $derived<JobKeepAwake>(getJobKeepAwake());

	const options: { value: JobKeepAwake; label: string }[] = [
		{ value: 'all', label: 'All jobs' },
		{ value: 'except-home', label: 'Not Home cards' },
		{ value: 'never', label: 'Never' }
	];
</script>

<section class="settings-section" id="keep-awake">
	<h2>Keep the computer awake</h2>
	<p
		class="hint lead"
		title="Holds off sleep only while a run is in flight or queued. Not Home cards leaves out Email digest, News digest, Research by email and Camera digest jobs. A scheduled job never wakes a sleeping computer."
	>
		While a job runs.
	</p>
	<div class="segmented">
		{#each options as opt (opt.value)}
			<button
				class:active={value === opt.value}
				onclick={() => updateSettings({ jobKeepAwake: opt.value })}
			>
				{opt.label}
			</button>
		{/each}
	</div>
</section>

<style>
	.lead {
		margin: -4px 0 10px;
	}
</style>
