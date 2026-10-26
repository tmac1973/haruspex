<script lang="ts">
	/**
	 * Settings → Feedback → View reports: the model's reports on Haruspex's
	 * tools, newest first, filterable by tool and kind, each with the calls
	 * behind it. Share saves a redacted zip and opens a pre-filled GitHub
	 * issue for it (see `harnessFeedback/reports.ts`).
	 */
	import Modal from '#lib/components/Modal.svelte';
	import {
		clearReports,
		countBy,
		kindLabel,
		loadReports,
		shareReports,
		toolLabel,
		type StoredReport
	} from '#lib/harnessFeedback/reports.ts';
	import { errMessage } from '#lib/utils/error.ts';

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	let { open, onclose }: Props = $props();

	let reports = $state<StoredReport[]>([]);
	let loading = $state(false);
	let status = $state('');
	let tool = $state('');
	let kind = $state('');

	const shown = $derived(
		reports.filter((r) => (!tool || r.tool === tool) && (!kind || r.kind === kind))
	);
	const tools = $derived(countBy(reports, (r) => r.tool));
	const kinds = $derived(countBy(reports, (r) => r.kind));

	async function load() {
		loading = true;
		status = '';
		try {
			reports = await loadReports();
		} catch (e) {
			status = `Could not read the reports: ${errMessage(e)}`;
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open) void load();
	});

	async function share() {
		status = '';
		try {
			const r = await shareReports(shown);
			status = `Saved ${r.count} report${r.count === 1 ? '' : 's'} to ${r.path}. Drag it onto the GitHub issue that opened in your browser.`;
		} catch (e) {
			status = `Could not share: ${errMessage(e)}`;
		}
	}

	async function clear() {
		if (!confirm(`Delete all ${reports.length} reports? This can't be undone.`)) return;
		try {
			await clearReports();
			reports = [];
			tool = '';
			kind = '';
		} catch (e) {
			status = `Could not delete the reports: ${errMessage(e)}`;
		}
	}

	function when(iso: string): string {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
	}
</script>

<Modal {open} {onclose} dismissable title="Model feedback" maxWidth={820} labelledBy="mf-title">
	{#if loading}
		<p class="muted">Loading…</p>
	{:else if reports.length === 0}
		<p class="muted">No reports yet.</p>
	{:else}
		<div class="bar">
			<select bind:value={tool} aria-label="Tool">
				<option value="">All tools ({reports.length})</option>
				{#each tools as [t, n] (t)}
					<option value={t}>{toolLabel(t)} ({n})</option>
				{/each}
			</select>
			<select bind:value={kind} aria-label="Kind">
				<option value="">All kinds</option>
				{#each kinds as [k, n] (k)}
					<option value={k}>{kindLabel(k)} ({n})</option>
				{/each}
			</select>
			<span class="spacer"></span>
			<button
				class="btn btn-primary"
				onclick={share}
				disabled={shown.length === 0}
				title="Saves the shown reports as a zip in your Downloads folder (secrets, URL query strings and email addresses removed), then opens that folder and a pre-filled GitHub issue to drag it onto."
			>
				Share {shown.length === reports.length ? 'all' : shown.length}
			</button>
			<button class="btn" onclick={clear}>Delete all</button>
		</div>

		<ul class="reports">
			{#each shown as r (r.recorded_at + r.tool + r.what_happened)}
				<li>
					<div class="head">
						<strong>{toolLabel(r.tool)}</strong>
						<span class="kind">{kindLabel(r.kind)}</span>
						<span class="muted"
							>{r.origin === 'reflection' ? 'job review' : r.mode} · {when(r.recorded_at)}</span
						>
					</div>
					<p><span class="label">What happened</span> {r.what_happened}</p>
					<p><span class="label">Expected</span> {r.expected}</p>
					{#if r.suggestion}
						<p><span class="label">Suggestion</span> {r.suggestion}</p>
					{/if}
					<details>
						<summary
							>{r.trace?.length ?? 0} calls · {r.model}{r.source ? ` · ${r.source}` : ''}</summary
						>
						{#each r.trace ?? [] as c, i (i)}
							<div class="call" class:failed={c.error}>
								<div class="call-name">{c.tool}{c.error ? ' (failed)' : ''}</div>
								<pre>{c.args}</pre>
								<pre>{c.result}</pre>
							</div>
						{/each}
					</details>
				</li>
			{/each}
		</ul>
	{/if}
	{#if status}
		<p class="status">{status}</p>
	{/if}
</Modal>

<style>
	.muted {
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.bar {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}

	.spacer {
		flex: 1;
	}

	.reports {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 60vh;
		overflow-y: auto;
	}

	.reports li {
		border-top: 1px solid var(--border);
		padding: 10px 0;
	}

	.head {
		display: flex;
		gap: 10px;
		align-items: baseline;
		flex-wrap: wrap;
	}

	.kind {
		font-size: 0.8rem;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--bg-secondary);
	}

	.reports p {
		margin: 6px 0 0;
		font-size: 0.9rem;
		line-height: 1.45;
	}

	.label {
		color: var(--text-secondary);
		font-size: 0.8rem;
		margin-right: 4px;
	}

	details {
		margin-top: 6px;
		font-size: 0.85rem;
	}

	summary {
		cursor: pointer;
		color: var(--text-secondary);
	}

	.call {
		margin: 8px 0 0 12px;
	}

	.call-name {
		font-family: monospace;
	}

	.call.failed .call-name {
		color: var(--error-text);
	}

	pre {
		margin: 4px 0 0;
		padding: 6px 8px;
		max-height: 12em;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
		background: var(--code-bg);
		border-radius: 4px;
		font-size: 0.8rem;
	}

	.status {
		margin: 12px 0 0;
		font-size: 0.85rem;
	}
</style>
