<script lang="ts">
	/**
	 * The 3D delegate's model picker: the Jobs model picker (remote or
	 * OpenRouter only) in a modal. Used by Settings → Code → Helpers → 3D and
	 * by a Code session's Extras menu, which adds **Use Settings**.
	 */
	import type { BackendOverride } from '#lib/api.ts';
	import Modal from '#lib/components/Modal.svelte';
	import ModalButton from '#lib/components/ModalButton.svelte';
	import JobModelFields from '#lib/components/jobs/JobModelFields.svelte';
	import { emptyModelForm, type JobModelForm } from '#lib/agent/jobs/jobModelForm.ts';
	import { backendFromModelForm, modelFormFromBackend } from '#lib/code/backends.ts';

	let {
		title,
		backend,
		onchoose,
		onusesettings,
		onclose
	}: {
		title: string;
		/** The model to start from; null opens on an empty OpenRouter form. */
		backend: BackendOverride | null;
		/** Save (a model) or None (null). */
		onchoose: (next: BackendOverride | null) => void;
		/** Shown as **Use Settings** when set. */
		onusesettings?: () => void;
		onclose: () => void;
	} = $props();

	// The form starts from the model it is given and is then the user's.
	// svelte-ignore state_referenced_locally
	let form = $state<JobModelForm>(
		backend ? modelFormFromBackend($state.snapshot(backend)) : emptyModelForm('openrouter')
	);
	const picked = $derived(backendFromModelForm($state.snapshot(form)));
</script>

<Modal open {title} maxWidth={560} dismissable {onclose}>
	<JobModelFields
		bind:form
		name="three-delegate-model-source"
		allowSettings={false}
		showAdvanced={false}
	/>
	<div class="button-row">
		<ModalButton onclick={() => onchoose(picked)} disabled={!picked?.modelId}>
			{#snippet title()}Save{/snippet}
		</ModalButton>
		<ModalButton variant="subtle" onclick={() => onchoose(null)}>
			{#snippet title()}None{/snippet}
		</ModalButton>
		{#if onusesettings}
			<ModalButton variant="subtle" onclick={onusesettings}>
				{#snippet title()}Use Settings{/snippet}
			</ModalButton>
		{/if}
		<ModalButton variant="subtle" onclick={onclose}>
			{#snippet title()}Cancel{/snippet}
		</ModalButton>
	</div>
</Modal>

<style>
	.button-row {
		margin-top: 16px;
	}
</style>
