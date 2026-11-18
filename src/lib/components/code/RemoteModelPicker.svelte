<script lang="ts">
	/**
	 * The model of a session running on another computer: one of that
	 * computer's own (its Settings model or a saved remote option, from its
	 * `models.list`), never this computer's. Keys stay there; a choice names
	 * one by its id.
	 */
	import Modal from '#lib/components/Modal.svelte';
	import ModalButton from '#lib/components/ModalButton.svelte';
	import type { SessionModel } from '#lib/engine/types.ts';
	import type { RemoteCodeSession } from '#lib/peers/remoteCodeSession.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { session }: { session: RemoteCodeSession } = $props();

	interface Profile {
		baseUrl: string;
		modelId: string;
		apiKeyId: string | null;
		contextSize: number | null;
	}
	interface ModelsList {
		settings: { model: string | null };
		profiles: { generic: Profile | null; openrouter: Profile | null };
	}
	interface Option {
		label: string;
		detail: string;
		model: SessionModel | null;
	}

	let open = $state(false);
	let options = $state<Option[] | null>(null);
	let error = $state<string | null>(null);
	let saving = $state(false);

	const label = $derived(
		session.model ? (session.model.modelId ?? session.model.baseUrl) : 'Its Settings model'
	);

	function asModel(p: Profile): SessionModel {
		return {
			baseUrl: p.baseUrl,
			modelId: p.modelId,
			...(p.apiKeyId ? { apiKeyId: p.apiKeyId } : {}),
			...(p.contextSize ? { contextSize: p.contextSize } : {})
		};
	}

	async function openPicker() {
		open = true;
		options = null;
		error = null;
		try {
			const list = await session.view.client.op<ModelsList>({ type: 'models.list' });
			const profiles = [list.profiles.generic, list.profiles.openrouter].filter(
				(p): p is Profile => !!p?.baseUrl && !!p.modelId
			);
			options = [
				{
					label: 'Its Settings model',
					detail: list.settings.model ?? '',
					model: null
				},
				...profiles.map((p) => ({ label: p.modelId, detail: p.baseUrl, model: asModel(p) }))
			];
		} catch (e) {
			error = errMessage(e);
		}
	}

	async function pick(model: SessionModel | null) {
		if (saving) return;
		saving = true;
		try {
			await session.setModel(model);
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
	aria-label="Model: {label}"
	title="A model on {session.peer.name}"
	disabled={session.busy}
	onclick={openPicker}
>
	<span>{label}</span>
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
	<Modal
		open
		title="Model on {session.peer.name}"
		maxWidth={480}
		dismissable
		onclose={() => (open = false)}
	>
		<p class="hint">Applies from the next message.</p>
		{#if error}
			<p class="error" role="alert">{error}</p>
		{:else if !options}
			<p class="hint">Reading its models…</p>
		{:else}
			<div class="options">
				{#each options as option (option.label + option.detail)}
					<ModalButton onclick={() => pick(option.model)}>
						{#snippet title()}{option.label}{/snippet}
						{#snippet subtitle()}{option.detail}{/snippet}
					</ModalButton>
				{/each}
			</div>
		{/if}
	</Modal>
{/if}

<style>
	/* As CodeModelPicker's button. */
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

	.options {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.hint {
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.error {
		color: var(--error, #b42318);
		font-size: 0.85rem;
	}
</style>
