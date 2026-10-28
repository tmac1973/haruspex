<script lang="ts">
	import Tooltip from '#lib/components/Tooltip.svelte';
	import type { GenerationKind, ToolchestInstance } from '#lib/toolchest/models.ts';

	// The instances a llama-toolchest server has enabled, running or not, as
	// its last probe listed them. Not the model sets it has downloaded: one
	// without an instance isn't listed, and isn't usable. Read only: instances
	// are made, and model sets installed, in toolchest; a stopped one starts on use.
	interface Props {
		kind: GenerationKind;
		instances: ToolchestInstance[];
		baseUrl: string;
	}
	let { kind, instances, baseUrl }: Props = $props();

	const what = $derived(kind);
</script>

<section class="settings-section">
	<h2>
		Instances on the server
		<Tooltip
			label="Where these come from"
			text={`llama-toolchest lists each ${what} instance it has enabled. A downloaded model needs an instance, made in llama-toolchest.`}
		/>
	</h2>
	{#each instances as i (i.id)}
		<div class="model">
			<div class="model-head">
				<strong>{i.id}</strong>
				<span class="badge" class:off={i.state !== 'running'}>{i.state}</span>
			</div>
			<p class="help" title={i.recipe || i.modelSet}>
				{i.modelSet}{#if i.capabilities.length > 0}
					· {i.capabilities.join(', ')}{/if}{#if i.licence !== 'unknown'}
					· {i.licence}{/if}
			</p>
			{#if i.commercialUse === false}
				<p class="warn">Not licensed for commercial use.</p>
			{/if}
		</div>
	{:else}
		<p class="help">No {what} models on this server.</p>
	{/each}
	<p class="help">
		A stopped instance starts when Haruspex first uses it.
		<a href={baseUrl} target="_blank" rel="noreferrer">Open llama-toolchest</a> to add one.
	</p>
</section>

<style>
	.badge.off {
		opacity: 0.6;
	}
</style>
