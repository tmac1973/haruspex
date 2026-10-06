<script lang="ts">
	/**
	 * The review dialog for a draft from `email_compose`. Mounted once in the
	 * root layout. Everything is editable; Send calls `email_send` and closes
	 * on success, and an error keeps the dialog open with the draft intact.
	 * Discard, Esc and the close button all discard, with the optional note
	 * passed back to the model.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { tick, untrack } from 'svelte';
	import Modal from './Modal.svelte';
	import {
		composedBody,
		getPendingEmailReview,
		isAddress,
		parseAddresses,
		resolveEmailReview
	} from '#lib/stores/emailReview.svelte.ts';
	import type { OutgoingMessage } from '#lib/ipc/gen/OutgoingMessage.ts';
	import type { SendOutcome } from '#lib/ipc/gen/SendOutcome.ts';

	const pending = $derived(getPendingEmailReview());

	let accountId = $state('');
	let to = $state('');
	let cc = $state('');
	let subject = $state('');
	let body = $state('');
	let note = $state('');
	let sending = $state(false);
	let error = $state<string | null>(null);
	let bodyEl = $state<HTMLTextAreaElement | undefined>();

	// Load each new draft into the fields.
	$effect(() => {
		const p = pending;
		if (!p) return;
		untrack(() => {
			accountId = p.draft.accountId;
			to = p.draft.to.join(', ');
			cc = p.draft.cc.join(', ');
			subject = p.draft.subject;
			body = p.draft.body;
			note = '';
			error = null;
			sending = false;
		});
		// A reply opens with the cursor at the top of the body.
		void tick().then(() => {
			bodyEl?.focus();
			bodyEl?.setSelectionRange(0, 0);
			if (bodyEl) bodyEl.scrollTop = 0;
		});
	});

	const toList = $derived(parseAddresses(to));
	const ccList = $derived(parseAddresses(cc));
	const badAddress = $derived([...toList, ...ccList].find((a) => !isAddress(a)));
	const canSend = $derived(
		!!pending && toList.length > 0 && !badAddress && subject.trim() !== '' && !sending
	);
	const from = $derived(pending?.accounts.find((a) => a.id === accountId));

	async function send() {
		if (!pending || !from || !canSend) return;
		sending = true;
		error = null;
		const message: OutgoingMessage = {
			to: toList,
			cc: ccList,
			subject: subject.trim(),
			body: composedBody(body, pending.draft.quoted),
			inReplyTo: pending.draft.inReplyTo,
			references: pending.draft.references
		};
		try {
			const out = await invoke<SendOutcome>('email_send', { account: from, message });
			resolveEmailReview({
				kind: 'sent',
				messageId: out.messageId,
				to: toList,
				sentCopyError: out.sentCopyError
			});
		} catch (e) {
			error = String(e);
		} finally {
			sending = false;
		}
	}

	function discard() {
		if (sending) return;
		resolveEmailReview({ kind: 'discarded', note: note.trim() });
	}
</script>

<Modal
	open={pending != null}
	maxWidth={720}
	title="Review email"
	dismissable
	onclose={discard}
	labelledBy="email-review-title"
>
	{#if pending}
		<div class="form">
			{#if pending.accounts.length > 1}
				<label>
					<span>From</span>
					<select bind:value={accountId} disabled={sending}>
						{#each pending.accounts as a (a.id)}
							<option value={a.id}>{a.label} — {a.emailAddress}</option>
						{/each}
					</select>
				</label>
			{:else if from}
				<p class="from">From {from.emailAddress}</p>
			{/if}
			<label>
				<span>To</span>
				<input type="text" bind:value={to} disabled={sending} />
			</label>
			<label>
				<span>Cc</span>
				<input type="text" bind:value={cc} disabled={sending} />
			</label>
			{#if badAddress}
				<p class="error-text">"{badAddress}" is not an email address.</p>
			{/if}
			<label>
				<span>Subject</span>
				<input type="text" bind:value={subject} disabled={sending} />
			</label>
			<textarea
				bind:this={bodyEl}
				bind:value={body}
				rows="12"
				aria-label="Message"
				disabled={sending}
			></textarea>
			{#if pending.draft.quoted}
				<details>
					<summary>Show quoted message</summary>
					<pre class="quoted">{pending.draft.quoted}</pre>
				</details>
			{/if}
			<label>
				<span>Note</span>
				<input
					type="text"
					bind:value={note}
					placeholder="Tell the assistant why (optional)"
					title="Sent back to the assistant if you discard the draft."
					disabled={sending}
				/>
			</label>
			{#if error}
				<p class="error-text">{error}</p>
			{/if}
			<div class="actions">
				<button type="button" class="btn" onclick={discard} disabled={sending}>Discard</button>
				<button type="button" class="btn btn-primary" onclick={send} disabled={!canSend}>
					{sending ? 'Sending…' : 'Send'}
				</button>
			</div>
		</div>
	{/if}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	label {
		display: grid;
		grid-template-columns: 4.5rem 1fr;
		align-items: center;
		gap: 0.5rem;
	}

	label span {
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.from {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	textarea {
		width: 100%;
		resize: vertical;
		font: inherit;
	}

	.quoted {
		white-space: pre-wrap;
		max-height: 14rem;
		overflow: auto;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
