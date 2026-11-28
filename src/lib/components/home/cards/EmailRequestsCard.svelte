<script lang="ts">
	/**
	 * Home's Email requests card: the requests its Research by email job has
	 * seen, newest first, with each one's state. Ignored ones are listed too,
	 * which is how someone probing the phrase shows up.
	 */
	import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
	import ChatMessage from '#lib/components/ChatMessage.svelte';
	import { jobSourceAttr } from '#lib/notebooks/source.ts';
	import { cardRunState } from '#lib/home/cardRun.ts';
	import { CARD_JOB_WAIT_TIP } from '#lib/home/jobsCard.ts';
	import { lastActive } from '#lib/code/sessionList.ts';
	import { getSettings } from '#lib/stores/settings.ts';
	import { getJob, getJobs } from '#lib/stores/jobs.svelte.ts';
	import { setActiveTab } from '#lib/stores/activeTab.svelte.ts';
	import { selectJob } from '#lib/stores/jobsTabSelection.svelte.ts';
	import { listEmailRequests, type EmailRequestRow } from '#lib/stores/emailRequests.ts';
	import {
		parseEmailResearchConfig,
		type EmailResearchConfig
	} from '#lib/agent/jobs/types/email-research/config.ts';
	import { stripPhrase } from '#lib/agent/jobs/types/email-research/body.ts';
	import {
		authLine,
		authSummary,
		reasonLabel,
		stateLabel,
		watchLine
	} from '#lib/home/emailRequests.ts';
	import { emailWatchState } from '#lib/agent/jobs/types/email-research/watch.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	/** Rows the card lists. */
	const LIMIT = 20;

	let { card }: { card: HomeCard } = $props();

	const jobId = $derived(card.job_id);
	const { latestRun, running, waiting, queued, failed } = $derived(cardRunState(jobId));

	/** The job's settings, read again whenever the job is saved. */
	let config = $state<EmailResearchConfig | null>(null);
	const jobSaved = $derived(getJobs().find((j) => j.id === jobId)?.updated_at);
	$effect(() => {
		const id = jobId;
		void jobSaved;
		if (id === null) return;
		let live = true;
		void getJob(id)
			.then((job) => {
				if (live && job) config = parseEmailResearchConfig(job.type_config);
			})
			.catch((e: unknown) => console.warn('Email requests: reading the job failed', e));
		return () => {
			live = false;
		};
	});

	/** The rows, read when the card mounts and after each run of its job. */
	let rows = $state<EmailRequestRow[] | null>(null);
	let readError = $state<string | null>(null);
	const runKey = $derived(`${latestRun?.latest?.id ?? ''}:${latestRun?.latest?.status ?? ''}`);
	$effect(() => {
		const id = jobId;
		void runKey;
		if (id === null) return;
		let live = true;
		void listEmailRequests(id, LIMIT)
			.then((r) => {
				if (!live) return;
				rows = r;
				readError = null;
			})
			.catch((e: unknown) => {
				if (live) readError = errMessage(e);
			});
		return () => {
			live = false;
		};
	});

	const account = $derived(
		config
			? (getSettings().integrations.email.accounts.find((a) => a.id === config?.accountId) ?? null)
			: null
	);
	/** Why the job can't run now, or null. */
	const blocked = $derived.by(() => {
		if (!config) return null;
		if (!account) return 'The email account was removed — Settings → Integrations → Email.';
		if (!account.enabled)
			return `${account.label} is turned off — Settings → Integrations → Email.`;
		if (!account.sendEnabled) {
			return `Allow sending is off for ${account.label} — Settings → Integrations → Email.`;
		}
		return null;
	});

	/** What the inbox watcher is doing, for a job that picks up on arrival. */
	const watch = $derived(
		jobId !== null && config?.pickup === 'arrival' && blocked === null
			? watchLine(emailWatchState(jobId))
			: null
	);

	let open = $state<number | null>(null);

	function subjectOf(row: EmailRequestRow): string {
		return stripPhrase(row.subject, config?.phrase ?? '') || '(no subject)';
	}

	function openRun(row: EmailRequestRow) {
		if (jobId === null) return;
		selectJob(jobId, row.runId);
		setActiveTab('jobs');
	}
</script>

{#if jobId === null}
	<p class="muted">This card's job was deleted. Remove the card and add it again.</p>
{:else}
	<div class="body" class:off={blocked !== null} title={blocked ?? undefined}>
		{#if config && account}
			<p class="setup">
				Email {account.emailAddress} with “{config.phrase}” in the subject.
			</p>
		{/if}
		{#if watch}
			<p class="muted" class:error={watch.problem} title={watch.detail}>{watch.text}</p>
		{/if}
		{#if running}
			<p class="muted" title={waiting ? CARD_JOB_WAIT_TIP : undefined}>
				{waiting ? 'Waiting for model…' : 'Checking for requests…'}
			</p>
		{:else if queued}
			<p class="muted">Queued</p>
		{/if}
		{#if failed}
			<p class="error" title={failed.error ?? undefined}>
				The last check failed{failed.error ? `: ${failed.error}` : '.'}
			</p>
		{/if}
		{#if readError}
			<p class="error" title={readError}>Couldn't read the requests: {readError}</p>
		{/if}
		{#if rows && rows.length > 0}
			<ul>
				{#each rows as row (row.id)}
					{@const reason = reasonLabel(row.state, row.reason)}
					{@const auth = authLine(row.auth)}
					<li>
						<button
							class="row"
							disabled={row.state !== 'answered'}
							aria-expanded={row.state === 'answered' ? open === row.id : undefined}
							title={row.state === 'answered' ? 'Show the question and answer' : undefined}
							onclick={() => (open = open === row.id ? null : row.id)}
						>
							<span class="subject">{subjectOf(row)}</span>
							<span class="meta">
								<span class="chip {row.state}">{stateLabel(row.state)}</span>
								{#if reason}<span class="reason">{reason}</span>{/if}
								<span class="when">{lastActive(row.updatedAt)}</span>
							</span>
							{#if auth}
								<span class="auth" title={authSummary(row.auth)}>{auth}</span>
							{/if}
						</button>
						{#if open === row.id}
							<div
								class="detail"
								data-notebook-source={jobId !== null
									? jobSourceAttr(jobId, row.runId, getJobs().find((j) => j.id === jobId)?.name)
									: undefined}
							>
								{#if row.question}
									<p class="question">{row.question}</p>
								{/if}
								{#if row.answer}
									<ChatMessage message={{ role: 'assistant', content: row.answer }} />
								{/if}
								{#if row.runId !== null}
									<button class="btn btn-small" onclick={() => openRun(row)}>Open run</button>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{:else if rows}
			<p class="muted">No requests yet.</p>
		{/if}
	</div>
{/if}

<style>
	.body.off {
		opacity: 0.55;
	}

	.setup {
		margin: 0 0 8px;
		font-size: 0.85rem;
		color: var(--text-secondary);
		overflow-wrap: anywhere;
	}

	.muted {
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.error {
		color: var(--error-text);
		font-size: 0.85rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.row {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 2px;
		width: 100%;
		text-align: left;
		padding: 6px 8px;
		border: none;
		border-radius: 6px;
		background: none;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.row:disabled {
		cursor: default;
	}

	.row:not(:disabled):hover {
		background: var(--bg-hover);
	}

	.subject {
		font-size: 0.9rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.chip {
		padding: 0 6px;
		border-radius: 8px;
		border: 1px solid var(--border);
	}

	.chip.answered {
		color: var(--success-text, inherit);
	}

	.chip.failed,
	.chip.ignored {
		color: var(--error-text);
	}

	.auth {
		font-size: 0.74rem;
		color: var(--text-secondary);
	}

	.detail {
		padding: 4px 8px 8px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.question {
		margin: 0;
		white-space: pre-wrap;
		font-style: italic;
		color: var(--text-secondary);
	}

	.detail .btn {
		align-self: flex-start;
	}
</style>
