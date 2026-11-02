<script lang="ts">
	/** Settings → General → Load tools when needed (`agent/tools/deferred.ts`). */
	import { getLiveSettings, updateSettings, type DeferTools } from '#lib/stores/settings.ts';

	const value = $derived<DeferTools>(getLiveSettings().deferTools ?? 'auto');
	const lean = $derived(getLiveSettings().leanMode);

	const options: { value: DeferTools; label: string }[] = [
		{ value: 'auto', label: 'Auto' },
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];
</script>

<section class="settings-section" id="load-tools">
	<h2>Load tools when needed</h2>
	<p
		class="hint lead"
		title="Auto turns it on for models above 12B. The model loads a group of tools, such as video editing, when a request needs it."
	>
		Sends fewer tools with each message.
	</p>
	<div class="segmented" title={lean ? 'Lean mode already sends a small tool list.' : undefined}>
		{#each options as opt (opt.value)}
			<button
				class:active={value === opt.value}
				disabled={lean}
				onclick={() => updateSettings({ deferTools: opt.value })}
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
