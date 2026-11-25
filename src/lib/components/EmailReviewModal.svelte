<script lang="ts">
	/**
	 * The review dialog for a draft from `email_compose`, Draft reply, or
	 * Email in Chat and Notebooks (`share/email.ts`). Mounted once in the
	 * root layout. Everything is editable; Send calls `email_send` and closes
	 * on success, and an error keeps the dialog open with the draft intact.
	 * Discard, Esc and the close button all discard, with the optional note
	 * passed back to the model.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { tick, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import Modal from '#lib/components/Modal.svelte';
	import {
		composedBody,
		getPendingEmailReview,
		isAddress,
		parseAddresses,
		resolveEmailReview,
		stagedIds
	} from '#lib/stores/emailReview.svelte.ts';
	import { keptAttachments, messageBody, previewHtml, sentSize } from '#lib/email/draftSend.ts';
	import { dropParts, formatSize, MAX_MESSAGE_BYTES, stagePart } from '#lib/email/parts.ts';
	import type { OutgoingMessage } from '#lib/ipc/gen/OutgoingMessage.ts';
	import type { SendOutcome } from '#lib/ipc/gen/SendOutcome.ts';
	import { errMessage } from '#lib/utils/error.ts';

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
	let toEl = $state<HTMLInputElement | undefined>();
	/** Attachments the user removed, by staged id. */
	const removed = new SvelteSet<string>();
	/** Optional files ticked, and the staged id of each one built. */
	let ticked = $state<Record<number, boolean>>({});
	let built: Record<number, { id: string; name: string }> = {};
	let preview = $state(false);

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
			removed.clear();
			ticked = {};
			built = {};
			preview = false;
		});
		// A reply opens with the cursor at the top of the body; a new message
		// with no recipient yet, in To.
		void tick().then(() => {
			if (p.draft.to.length === 0) {
				toEl?.focus();
				return;
			}
			bodyEl?.focus();
			bodyEl?.setSelectionRange(0, 0);
			if (bodyEl) bodyEl.scrollTop = 0;
		});
	});

	const toList = $derived(parseAddresses(to));
	const ccList = $derived(parseAddresses(cc));
	const badAddress = $derived([...toList, ...ccList].find((a) => !isAddress(a)));
	const markdown = $derived(pending?.draft.format === 'markdown');
	const attachments = $derived(keptAttachments(pending?.draft.attachments ?? [], removed));
	const size = $derived(pending ? sentSize(pending.draft, body, removed) : 0);
	const tooLarge = $derived(size > MAX_MESSAGE_BYTES);
	const canSend = $derived(
		!!pending && toList.length > 0 && !badAddress && subject.trim() !== '' && !sending && !tooLarge
	);
	const from = $derived(pending?.accounts.find((a) => a.id === accountId));

	/** Stage the ticked optional files; each is built once, so Send can be retried. */
	async function extraParts(): Promise<{ id: string; name: string }[]> {
		const opts = pending?.draft.optional ?? [];
		const files: { id: string; name: string }[] = [];
		for (const [i, opt] of opts.entries()) {
			if (!ticked[i]) continue;
			if (!built[i]) {
				const f = await opt.build();
				built[i] = { id: await stagePart(f.name, f.mime, f.bytes), name: f.name };
			}
			files.push(built[i]);
		}
		return files;
	}

	/** Drop every file this draft staged; the ones just sent are already gone. */
	function dropStaged() {
		if (!pending) return;
		void dropParts([...stagedIds(pending.draft), ...Object.values(built).map((b) => b.id)]);
		built = {};
	}

	async function send() {
		if (!pending || !from || !canSend) return;
		sending = true;
		error = null;
		try {
			const text = composedBody(body, pending.draft.quoted);
			const extra = await extraParts();
			const message: OutgoingMessage = {
				to: toList,
				cc: ccList,
				subject: subject.trim(),
				...messageBody(
					pending.draft,
					text,
					removed,
					extra.map((f) => ({ id: f.id }))
				),
				inReplyTo: pending.draft.inReplyTo,
				references: pending.draft.references
			};
			const out = await invoke<SendOutcome>('email_send', { account: from, message });
			dropStaged();
			resolveEmailReview({
				kind: 'sent',
				messageId: out.messageId,
				to: toList,
				sentCopyError: out.sentCopyError,
				attached: [...attachments.map((a) => a.name), ...extra.map((f) => f.name)]
			});
		} catch (e) {
			error = errMessage(e);
		} finally {
			sending = false;
		}
	}

	function discard() {
		if (sending) return;
		dropStaged();
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
				<input type="text" bind:this={toEl} bind:value={to} disabled={sending} />
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
			{#if markdown && preview}
				<div class="preview" aria-label="Preview">
					<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised by mailBody -->
					{@html previewHtml(pending.draft, composedBody(body, pending.draft.quoted))}
				</div>
			{:else}
				<textarea
					bind:this={bodyEl}
					bind:value={body}
					rows="12"
					aria-label="Message"
					disabled={sending}></textarea>
			{/if}
			{#if markdown}
				<div class="body-tools">
					<button type="button" class="link-btn" onclick={() => (preview = !preview)}>
						{preview ? 'Edit' : 'Preview'}
					</button>
					<span
						class="hint"
						title="Sent as formatted text, with a plain-text copy for mail apps that show only text."
					>
						Markdown
					</span>
				</div>
			{/if}
			{#if attachments.length || pending.draft.optional?.length}
				<div class="files" aria-label="Attachments">
					{#each attachments as a (a.partId)}
						<span class="chip">
							📎 {a.name} <span class="size">{formatSize(a.size)}</span>
							<button
								type="button"
								class="chip-x"
								aria-label="Remove {a.name}"
								title="Don't attach this"
								onclick={() => removed.add(a.partId)}
								disabled={sending}
							>
								×
							</button>
						</span>
					{/each}
					{#each pending.draft.optional ?? [] as opt, i (opt.label)}
						<label class="check">
							<input type="checkbox" bind:checked={ticked[i]} disabled={sending} />
							{opt.label}
						</label>
					{/each}
				</div>
			{/if}
			{#if size > 0}
				<p class="total" class:error-text={tooLarge}>
					{tooLarge
						? `The files add up to ${formatSize(size)}, over the ${formatSize(MAX_MESSAGE_BYTES)} an email can carry.`
						: `Files: ${formatSize(size)}`}
				</p>
			{/if}
			{#if pending.draft.skipped?.length}
				<p class="total" title="Too large to send, or they could not be read.">
					Left out: {pending.draft.skipped.join(', ')}
				</p>
			{/if}
			{#if pending.draft.quoted}
				<details>
					<summary>Show quoted message</summary>
					<pre class="quoted">{pending.draft.quoted}</pre>
				</details>
			{/if}
			{#if pending.note}
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
			{/if}
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

	/* The mail as it will look: white, whatever the app's theme. */
	.preview {
		max-height: 24rem;
		overflow: auto;
		padding: 12px 16px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: #fff;
		color: #222;
	}

	.body-tools {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.85rem;
	}

	.link-btn {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		cursor: pointer;
		font: inherit;
	}

	.hint,
	.total,
	.size {
		color: var(--text-secondary);
		font-size: 0.85rem;
		margin: 0;
	}

	.files {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 2px 4px 2px 8px;
		border: 1px solid var(--border);
		border-radius: 12px;
		font-size: 0.85rem;
	}

	.chip-x {
		background: none;
		border: none;
		cursor: pointer;
		color: var(--text-secondary);
		padding: 0 4px;
	}

	.check {
		display: inline-flex;
		grid-template-columns: none;
		gap: 0.3rem;
		font-size: 0.85rem;
	}
</style>
