<script lang="ts">
	/**
	 * A Code session's model: a button naming it, and the Jobs model picker in
	 * a modal. Follows Settings, or a specific remote or OpenRouter model;
	 * never the local model directly, so nothing here can start llama-server.
	 */
	import Modal from '#lib/components/Modal.svelte';
	import ModalButton from '#lib/components/ModalButton.svelte';
	import JobModelFields from '#lib/components/jobs/JobModelFields.svelte';
	import {
		backendFromModelForm,
		modelFormFromBackend,
		sessionModelLabel
	} from '#lib/code/backends.ts';
	import { emptyModelForm, type JobModelForm } from '#lib/agent/jobs/jobModelForm.ts';
	import type { CodeSession } from '#lib/stores/code.svelte.ts';
	import { getLiveSettings } from '#lib/stores/settings.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { session }: { session: CodeSession } = $props();

	const label = $derived(sessionModelLabel(session.backend, getLiveSettings()));

	let open = $state(false);
	let saving = $state(false);
	let form = $state<JobModelForm>(emptyModelForm());

	function openPicker() {
		form = modelFormFromBackend($state.snapshot(session.backend));
		open = true;
	}

	async function save() {
		if (saving) return;
		saving = true;
		try {
			await session.setBackend(backendFromModelForm($state.snapshot(form)));
			open = false;
		} catch (e) {
			showToast(`Couldn't change the model: ${errMessage(e)}`, { kind: 'error' });
		} finally {
			saving = false;
		}
	}
</script>

<button
	class="model"
	aria-label="Model: {label.label}"
	title={label.title}
	disabled={session.busy}
	onclick={openPicker}
>
	<span>{label.label}</span>
	<svg
		width="10"
		height="10"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2.5"
		aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg
	>
</button>

{#if open}
	<Modal open title="Session model" maxWidth={560} dismissable onclose={() => (open = false)}>
		<p class="hint">Applies from the next message.</p>
		<JobModelFields
			bind:form
			name="code-session-model-source"
			showAdvanced={false}
			settingsLabel={{
				title: 'Settings model',
				description: 'Follows Settings → Inference.'
			}}
		/>
		<div class="button-row">
			<ModalButton onclick={save}>
				{#snippet title()}{saving ? 'Saving…' : 'Save'}{/snippet}
			</ModalButton>
			<ModalButton variant="subtle" onclick={() => (open = false)}>
				{#snippet title()}Cancel{/snippet}
			</ModalButton>
		</div>
	</Modal>
{/if}

<style>
	.model {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 260px;
		padding: 3px 8px;
		font-size: 0.76rem;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		cursor: pointer;
	}

	.model span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.model:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.hint {
		margin: 0 0 10px;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.button-row {
		margin-top: 16px;
	}
</style>
