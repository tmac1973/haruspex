<script lang="ts">
	/**
	 * Home's Important emails card: the unread messages its email digest job
	 * picked. Subject, sender and date come from IMAP; only the reason under
	 * each is the model's.
	 */
	import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
	import type { ImportantEmail } from '#lib/agent/jobs/types/email-digest/pipeline.ts';
	import { getCurrentRun, getPendingQueue } from '#lib/agent/jobs/runner.svelte.ts';
	import { getLatestRun } from '#lib/home/latestRun.svelte.ts';
	import { lastActive } from '#lib/code/sessionList.ts';
	import { getSettings } from '#lib/stores/settings.ts';
	import { askAbout } from '#lib/home/askAbout.ts';
	import ItemActions, { type ItemAction } from '#lib/components/home/ItemActions.svelte';
	import EmailReader from '#lib/components/home/EmailReader.svelte';
	import DraftReply from '#lib/components/home/DraftReply.svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import { isTrashed, trashEmail } from '#lib/home/trashedEmails.svelte.ts';

	let { card }: { card: HomeCard } = $props();

	const jobId = $derived(card.job_id);
	const latestRun = $derived(jobId === null ? null : getLatestRun(jobId));
	const running = $derived.by(() => {
		const run = getCurrentRun();
		return run !== null && run.jobId === jobId && run.status === 'running';
	});
	const waiting = $derived(running ? (getCurrentRun()?.waitingForSlot ?? false) : false);
	const queued = $derived(getPendingQueue().some((q) => q.jobId === jobId));
	const failed = $derived(latestRun?.latest?.status === 'failed' ? latestRun.latest : null);
	const items = $derived.by((): ImportantEmail[] | null => {
		const json = latestRun?.latestSucceeded?.result_json;
		if (!json) return null;
		try {
			const all = (JSON.parse(json) as { items: ImportantEmail[] }).items;
			return all.filter((item) => !isTrashed(item.id));
		} catch {
			return null;
		}
	});

	/** The message open in the reader, and the one with a draft panel under it. */
	let reading = $state<ImportantEmail | null>(null);
	let drafting = $state<string | null>(null);
	/** The message whose Delete asks first, and why the last delete failed. */
	let deleting = $state<ImportantEmail | null>(null);
	let deleteError = $state<string | null>(null);

	async function confirmDelete() {
		const item = deleting;
		const account = item ? accountOf(item) : undefined;
		deleting = null;
		if (!item || !account) return;
		deleteError = null;
		try {
			await trashEmail(account, item.id, item.source.messageId);
		} catch (e) {
			deleteError = `Couldn't delete "${item.source.subject}": ${String(e)}`;
		}
	}

	function accountOf(item: ImportantEmail) {
		return getSettings().integrations.email.accounts.find((a) => a.id === item.source.accountId);
	}

	function actions(item: ImportantEmail): ItemAction[] {
		const account = accountOf(item);
		const noSend = !account?.sendEnabled
			? 'Turn on Allow sending in Settings → Integrations → Email'
			: undefined;
		return [
			{
				label: 'Open',
				run: () => (reading = item),
				disabledReason: account ? undefined : 'This account was removed from Settings'
			},
			{
				label: 'Ask about this',
				run: () => askAbout('Important emails', { kind: 'email', item })
			},
			{ label: 'Draft reply', run: () => (drafting = item.id), disabledReason: noSend },
			{
				label: 'Delete',
				run: () => (deleting = item),
				disabledReason: account ? undefined : 'This account was removed from Settings'
			}
		];
	}

	function when(date: string): string {
		const at = Date.parse(date);
		return Number.isNaN(at) ? '' : lastActive(at);
	}
</script>

{#if jobId === null}
	<p class="muted">This card's job was deleted. Remove the card and add it again.</p>
{:else}
	{#if running}
		<p class="muted">{waiting ? 'Waiting for chat…' : 'Checking your mail…'}</p>
	{:else if queued}
		<p class="muted">Queued</p>
	{/if}
	{#if failed}
		<p class="error" title={failed.error ?? undefined}>
			The last check failed{failed.error ? `: ${failed.error}` : '.'}
		</p>
	{/if}
	{#if deleteError}
		<p class="error" title={deleteError}>{deleteError}</p>
	{/if}
	{#if items && items.length > 0}
		<ul>
			{#each items as item (item.id)}
				<li>
					<div class="head">
						<span class="subject">{item.source.subject || '(no subject)'}</span>
						<span class="date">{when(item.source.date)}</span>
						<ItemActions label={item.source.subject} actions={actions(item)} />
					</div>
					<div class="from">{item.source.from}</div>
					<div class="why">{item.why}</div>
					{#if drafting === item.id && accountOf(item)}
						<DraftReply
							account={accountOf(item)!}
							messageId={item.source.messageId}
							onclose={() => (drafting = null)}
						/>
					{/if}
				</li>
			{/each}
		</ul>
	{:else if items}
		<p class="muted">No important mail.</p>
	{:else if !running && !queued && !failed}
		<p class="muted">Not checked yet.</p>
	{/if}
	{#if reading && accountOf(reading)}
		{@const item = reading}
		<EmailReader
			account={accountOf(item)!}
			messageId={item.source.messageId}
			ondraft={accountOf(item)?.sendEnabled
				? () => {
						reading = null;
						drafting = item.id;
					}
				: undefined}
			onclose={() => (reading = null)}
		/>
	{/if}
	<ConfirmDialog
		open={deleting !== null}
		title="Delete email"
		confirmLabel="Move to Trash"
		destructive
		onconfirm={() => void confirmDelete()}
		oncancel={() => (deleting = null)}
	>
		<p>"{deleting?.source.subject || '(no subject)'}" goes to the account's Trash.</p>
	</ConfirmDialog>
{/if}

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li + li {
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--border);
	}

	.head {
		display: flex;
		justify-content: space-between;
		gap: 8px;
	}

	.subject {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}

	.date,
	.from,
	.muted {
		color: var(--text-secondary);
	}

	.date {
		flex-shrink: 0;
		font-size: 0.75rem;
	}

	.from {
		font-size: 0.8rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The model's words, apart from the message's. */
	.why {
		margin-top: 2px;
		padding-left: 6px;
		border-left: 2px solid var(--accent);
		font-size: 0.8rem;
	}

	.muted,
	.error {
		margin: 4px 0;
	}

	.error {
		color: var(--error-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
