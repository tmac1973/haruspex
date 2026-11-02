<script lang="ts">
	/** Open, on an Important emails row: the whole message, read from IMAP. */
	import Modal from '#lib/components/Modal.svelte';
	import { emailCall, type NormalizedEmailMessage } from '#lib/agent/tools/email.ts';
	import type { EmailAccount } from '#lib/stores/settings.ts';
	import { errMessage } from '#lib/utils/error.ts';

	interface Props {
		account: EmailAccount;
		messageId: string;
		/** Open Draft reply for this message; absent when the account can't send. */
		ondraft?: () => void;
		onclose: () => void;
	}

	let { account, messageId, ondraft, onclose }: Props = $props();

	let message = $state<NormalizedEmailMessage | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		const abort = new AbortController();
		void emailCall<NormalizedEmailMessage>('email_read_full', { account, messageId }, abort.signal)
			.then((m) => (message = m))
			.catch((e) => {
				if (!abort.signal.aborted) error = `Couldn't read it: ${errMessage(e)}`;
			});
		return () => abort.abort();
	});
</script>

<Modal open title={message?.subject || 'Email'} dismissable {onclose} maxWidth={680}>
	{#if error}
		<p class="error">{error}</p>
	{:else if !message}
		<p class="muted">Reading…</p>
	{:else}
		<dl class="headers">
			<dt>From</dt>
			<dd>{message.fromName ? `${message.fromName} <${message.fromEmail}>` : message.fromEmail}</dd>
			<dt>To</dt>
			<dd>{message.to.join(', ')}</dd>
			{#if message.cc.length}
				<dt>Cc</dt>
				<dd>{message.cc.join(', ')}</dd>
			{/if}
			<dt>Date</dt>
			<dd>{new Date(message.date).toLocaleString()}</dd>
		</dl>
		<pre class="body">{message.body}</pre>
		{#if message.hasAttachments}
			<p class="muted">It has attachments; open it in your mail app to see them.</p>
		{/if}
	{/if}
	<div class="buttons">
		{#if ondraft}
			<button type="button" class="btn" onclick={ondraft} disabled={!message}>Draft reply</button>
		{/if}
		<button type="button" class="btn btn-primary" onclick={onclose}>Close</button>
	</div>
</Modal>

<style>
	.headers {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px 10px;
		margin: 0 0 10px;
		font-size: 0.85rem;
	}

	dt {
		color: var(--text-secondary);
	}

	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.body {
		max-height: 50vh;
		overflow-y: auto;
		margin: 0;
		white-space: pre-wrap;
		font-family: inherit;
		font-size: 0.88rem;
	}

	.muted {
		color: var(--text-secondary);
	}

	.error {
		color: var(--error-text);
	}

	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 12px;
	}
</style>
