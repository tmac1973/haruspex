<script lang="ts">
	/**
	 * Draft reply, under an Important emails row: say how to reply, watch the
	 * draft stream in, edit it, then Review & send. Only the Review email
	 * dialog's Send sends.
	 */
	import { draftReply } from '#lib/home/draftReply.ts';
	import { askEmailReview, type EmailDraft } from '#lib/stores/emailReview.svelte.ts';
	import { getSettings, type EmailAccount } from '#lib/stores/settings.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	interface Props {
		account: EmailAccount;
		messageId: string;
		onclose: () => void;
	}

	let { account, messageId, onclose }: Props = $props();

	let instruction = $state('');
	let body = $state('');
	let draft = $state<EmailDraft | null>(null);
	let abort = $state<AbortController | null>(null);
	let error = $state<string | null>(null);
	const streaming = $derived(abort !== null);

	async function generate() {
		abort?.abort();
		const controller = new AbortController();
		abort = controller;
		error = null;
		body = '';
		try {
			draft = await draftReply({
				account,
				messageId,
				instruction,
				signal: controller.signal,
				onDelta: (text) => (body = text)
			});
			body = draft.body;
		} catch (e) {
			if (!controller.signal.aborted) error = `Couldn't draft it: ${errMessage(e)}`;
		} finally {
			if (abort === controller) abort = null;
		}
	}

	function stop() {
		abort?.abort();
		abort = null;
	}

	async function review() {
		if (!draft) return;
		const sendable = getSettings().integrations.email.accounts.filter(
			(a) => a.enabled && a.sendEnabled
		);
		try {
			const outcome = await askEmailReview({ ...draft, body }, sendable);
			if (outcome.kind === 'sent') {
				showToast('Reply sent.');
				onclose();
			}
		} catch (e) {
			error = errMessage(e);
		}
	}

	$effect(() => () => abort?.abort());
</script>

<div class="draft">
	<div class="ask">
		<input
			type="text"
			bind:value={instruction}
			placeholder="How to reply (optional), e.g. decline politely"
			aria-label="How to reply"
			disabled={streaming}
			onkeydown={(e) => {
				if (e.key === 'Enter') void generate();
			}}
		/>
		{#if streaming}
			<button type="button" class="btn btn-small" onclick={stop}>Stop</button>
		{:else}
			<button type="button" class="btn btn-small" onclick={() => void generate()}
				>{draft ? 'Regenerate' : 'Draft'}</button
			>
		{/if}
	</div>
	{#if streaming || draft}
		<textarea bind:value={body} rows="6" readonly={streaming} aria-label="Reply"></textarea>
	{/if}
	{#if error}
		<p class="error">{error}</p>
	{/if}
	<div class="buttons">
		<button type="button" class="btn btn-small" onclick={onclose}>Cancel</button>
		<button
			type="button"
			class="btn btn-small btn-primary"
			onclick={() => void review()}
			disabled={!draft || streaming || !body.trim()}
			title="Opens the Review email window; nothing is sent until you press Send there"
			>Review & send</button
		>
	</div>
</div>

<style>
	.draft {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 6px;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
	}

	.ask {
		display: flex;
		gap: 6px;
	}

	.ask input {
		flex: 1;
		min-width: 0;
	}

	textarea {
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		font-size: 0.85rem;
	}

	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
	}

	.error {
		margin: 0;
		color: var(--error-text);
		font-size: 0.8rem;
	}
</style>
