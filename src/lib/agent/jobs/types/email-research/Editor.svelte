<script lang="ts">
	// Research by email's section of the job editor (see JobTypeEditorProps),
	// also the body of Home's Add card form for Email requests.
	import { onMount } from 'svelte';
	import Tooltip from '#lib/components/Tooltip.svelte';
	import { getSettings } from '#lib/stores/settings.ts';
	import {
		MAX_DAILY_LIMIT,
		DEFAULT_DAILY_LIMIT,
		PHRASE_MAX,
		type EmailResearchConfig
	} from '#lib/agent/jobs/types/email-research/config.ts';
	import { emailResearchWarnings } from '#lib/agent/jobs/types/email-research/warnings.ts';
	import {
		accountTakenBy,
		loadEmailResearchAccounts
	} from '#lib/agent/jobs/types/email-research/accountJobs.svelte.ts';

	let {
		config = $bindable(),
		jobId = 'new'
	}: { config: Record<string, unknown>; jobId?: number | 'new' } = $props();

	const cfg = config as unknown as EmailResearchConfig;
	const accounts = getSettings().integrations.email.accounts;
	const ownId = $derived(jobId === 'new' ? undefined : jobId);

	onMount(() => {
		void loadEmailResearchAccounts().catch((e) =>
			console.warn('email_research: could not list jobs', e)
		);
	});

	function blocked(id: string, sendEnabled: boolean): string | null {
		if (!sendEnabled) return 'Allow sending is off — Settings → Integrations → Email.';
		if (accountTakenBy(id, ownId) !== null) return 'Already has a job.';
		return null;
	}

	const account = $derived(accounts.find((a) => a.id === cfg.accountId) ?? null);
	const warnings = $derived(emailResearchWarnings(cfg.phrase, account?.provider ?? null));

	let unlimited = $state(cfg.dailyLimit === null);
	let limit = $state(cfg.dailyLimit ?? DEFAULT_DAILY_LIMIT);
	$effect(() => {
		cfg.dailyLimit = unlimited ? null : limit;
	});
</script>

<label class="field">
	<span class="label">
		Email account
		<Tooltip
			label="About the email account"
			text="Requests are emails from this account to itself. Replies go only to this address. It needs Allow sending in Settings → Integrations → Email."
		/>
	</span>
	{#if accounts.length === 0}
		<p class="hint">No email accounts yet. Add one in Settings → Integrations → Email.</p>
	{:else}
		<select bind:value={cfg.accountId} required={!cfg.accountId}>
			<option value="" disabled>Choose an account</option>
			{#each accounts as a (a.id)}
				{@const why = blocked(a.id, a.sendEnabled)}
				<option value={a.id} disabled={why !== null} title={why ?? a.emailAddress}>
					{a.label} ({a.emailAddress}){why ? ` — ${why}` : ''}
				</option>
			{/each}
		</select>
	{/if}
</label>

<label class="field">
	<span class="label">
		Trigger phrase
		<Tooltip
			label="About the trigger phrase"
			text="A request's subject must contain this. Case doesn't matter. Haruspex also checks that a copy of the request is in your Sent folder."
		/>
	</span>
	<input
		type="text"
		bind:value={cfg.phrase}
		maxlength={PHRASE_MAX}
		required={!cfg.phrase.trim()}
		placeholder="ask haruspex"
	/>
	{#each warnings as w (w.text)}
		<span class="warning" title={w.detail}>{w.text}</span>
	{/each}
</label>

<div class="field">
	<span class="label">
		Daily limit
		<Tooltip
			label="About the daily limit"
			text="The most requests researched each day, counted from midnight. Requests over it are ignored and moved to Haruspex/Ignored."
		/>
	</span>
	<div class="limit">
		<input
			type="number"
			min="1"
			max={MAX_DAILY_LIMIT}
			bind:value={limit}
			disabled={unlimited}
			aria-label="Requests a day"
		/>
		<label class="check">
			<input type="checkbox" bind:checked={unlimited} />
			No limit
		</label>
	</div>
</div>

<label class="check pickup">
	<input
		type="checkbox"
		bind:checked={
			() => cfg.pickup === 'arrival', (on) => (cfg.pickup = on ? 'arrival' : 'schedule')
		}
	/>
	Answer when mail arrives
	<Tooltip
		label="About answering when mail arrives"
		text="Haruspex keeps a connection to the inbox open and starts within seconds of a request arriving. The schedule below is the backup check. Haruspex must be open."
	/>
</label>

<style>
	.label {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.hint {
		font-style: italic;
	}

	.warning {
		font-size: 0.8rem;
		color: var(--warning, var(--text-secondary));
	}

	.limit {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.limit input[type='number'] {
		width: 6rem;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.88rem;
	}
</style>
