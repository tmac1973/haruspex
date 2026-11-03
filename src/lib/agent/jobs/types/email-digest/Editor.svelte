<script lang="ts">
	// The email digest's section of the job editor (see JobTypeEditorProps),
	// also the body of Home's Add card form for Important emails.
	import Tooltip from '#lib/components/Tooltip.svelte';
	import { getSettings } from '#lib/stores/settings.ts';
	import type { EmailDigestConfig } from '#lib/agent/jobs/types/email-digest/config.ts';

	let { config = $bindable() }: { config: Record<string, unknown> } = $props();

	const cfg = config as unknown as EmailDigestConfig;
	const accounts = getSettings().integrations.email.accounts;

	function toggle(id: string, on: boolean) {
		cfg.accountIds = on ? [...cfg.accountIds, id] : cfg.accountIds.filter((a) => a !== id);
	}
</script>

<fieldset class="field accounts">
	<legend class="label">
		Email accounts
		<Tooltip
			label="About the email accounts"
			text="The unread mail in each account's inbox is what the model picks from. Add accounts in Settings → Integrations → Email."
		/>
	</legend>
	{#if accounts.length === 0}
		<p class="hint">No email accounts yet. Add one in Settings → Integrations → Email.</p>
	{:else}
		<div class="list">
			{#each accounts as account (account.id)}
				<label class="check">
					<input
						type="checkbox"
						checked={cfg.accountIds.includes(account.id)}
						onchange={(e) => toggle(account.id, (e.currentTarget as HTMLInputElement).checked)}
						required={cfg.accountIds.length === 0}
					/>
					{account.label}{account.enabled ? '' : ' (off)'}
				</label>
			{/each}
		</div>
	{/if}
</fieldset>

<label class="field">
	<span class="label">
		What counts as important
		<Tooltip
			label="About the rule"
			text="The model reads each unread message's sender, subject and first lines and keeps the ones that fit this. It never sees the whole message."
		/>
	</span>
	<input
		type="text"
		bind:value={cfg.rule}
		required={!cfg.rule.trim()}
		placeholder="From my manager, or about invoices"
	/>
</label>

<div class="grid">
	<label class="field">
		<span class="label">Look back (hours)</span>
		<input type="number" min="1" max="168" bind:value={cfg.hours} />
	</label>
	<label class="field">
		<span class="label">
			Show at most
			<Tooltip
				label="About the limit"
				text="The most messages the card shows. Each check still reads your unread mail from the look-back window; the model picks the best matches, most important first, up to this many."
			/>
		</span>
		<input type="number" min="1" max="20" bind:value={cfg.max} />
	</label>
</div>

<style>
	.label {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.accounts {
		border: none;
		margin: 0;
		padding: 0;
	}

	/* A box of its own, so a long list scrolls where you can see it does. */
	.list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		/* Six and a half rows: a cut row says there is more. */
		max-height: 155px;
		overflow-y: auto;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
	}

	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.88rem;
	}

	.hint {
		font-style: italic;
	}

	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
</style>
