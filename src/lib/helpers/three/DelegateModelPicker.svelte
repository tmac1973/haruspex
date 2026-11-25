<script lang="ts">
	/**
	 * The 3D delegate's model picker: the Jobs model picker (remote or
	 * OpenRouter) in a modal, with **None** as a last source. A Code session's
	 * Extras menu adds **Settings** as the first, to follow Settings → Code →
	 * Helpers → 3D; Settings itself has no such choice.
	 */
	import type { BackendOverride } from '#lib/api.ts';
	import Modal from '#lib/components/Modal.svelte';
	import ModalButton from '#lib/components/ModalButton.svelte';
	import JobModelFields from '#lib/components/jobs/JobModelFields.svelte';
	import { emptyModelForm, type JobModelForm } from '#lib/agent/jobs/jobModelForm.ts';
	import { backendFromModelForm, modelFormFromBackend } from '#lib/code/backends.ts';

	/** What the picker opens on: a model, none, or following Settings. */
	export type DelegateChoice = BackendOverride | null | undefined;

	let {
		title,
		current,
		onchoose,
		onusesettings,
		onclose
	}: {
		title: string;
		/** The model it opens on; null opens on None, undefined on Settings. */
		current: DelegateChoice;
		/** Save with a model, or with None (null). */
		onchoose: (next: BackendOverride | null) => void;
		/** Offers the Settings source, and is called on Save with it picked. */
		onusesettings?: () => void;
		onclose: () => void;
	} = $props();

	// The form starts from the model it is given and is then the user's.
	// svelte-ignore state_referenced_locally
	let form = $state<JobModelForm>(
		current
			? modelFormFromBackend($state.snapshot(current))
			: emptyModelForm(current === undefined && onusesettings ? 'settings' : 'openrouter')
	);
	// svelte-ignore state_referenced_locally
	let none = $state(current === null);
	const picked = $derived(backendFromModelForm($state.snapshot(form)));
	const followsSettings = $derived(!none && form.source === 'settings');
	const canSave = $derived(none || followsSettings || !!picked?.modelId);

	function save() {
		if (none) onchoose(null);
		else if (followsSettings) onusesettings?.();
		else if (picked) onchoose(picked);
	}
</script>

<Modal open {title} maxWidth={560} dismissable {onclose}>
	<JobModelFields
		bind:form
		bind:none
		name="three-delegate-model-source"
		allowSettings={onusesettings !== undefined}
		settingsLabel={{
			title: 'Settings',
			description: 'Follows Settings → Code → Helpers → 3D.'
		}}
		noneOption={{ title: 'None', description: 'No delegate: the agent builds 3D assets itself.' }}
		showAdvanced={false}
	/>
	<div class="button-row">
		<ModalButton onclick={save} disabled={!canSave}>
			{#snippet title()}Save{/snippet}
		</ModalButton>
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
