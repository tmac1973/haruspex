<script lang="ts">
	import Tooltip from '#lib/components/Tooltip.svelte';
	import type { GenerationKind, ToolchestInstance } from '#lib/toolchest/models.ts';

	// What a llama-toolchest server runs, as its last probe listed it. Read
	// only: instances are started, and model sets installed, in toolchest.
	interface Props {
		kind: GenerationKind;
		instances: ToolchestInstance[];
		baseUrl: string;
	}
	let { kind, instances, baseUrl }: Props = $props();

	const what = $derived(kind === 'image' ? 'image' : 'music');
</script>

<section class="settings-section">
	<h2>
		Models on the server
		<Tooltip
			label="Where these come from"
			text={`llama-toolchest lists every ${what} instance it has. Starting one, or adding a model, happens in llama-toolchest.`}
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
		<a href={baseUrl} target="_blank" rel="noreferrer">Open llama-toolchest</a> to start or add one.
	</p>
</section>

<style>
	.badge.off {
		opacity: 0.6;
	}
</style>
