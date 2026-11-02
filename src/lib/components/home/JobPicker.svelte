<script lang="ts">
	/** Pick a job to pin to Home. */
	import Modal from '#lib/components/Modal.svelte';
	import { getJobs } from '#lib/stores/jobs.svelte.ts';
	import { getJobType } from '#lib/agent/jobs/types/index.ts';

	interface Props {
		open: boolean;
		onpick: (jobId: number) => void;
		oncancel: () => void;
	}

	let { open, onpick, oncancel }: Props = $props();

	let filter = $state('');
	const jobs = $derived(
		getJobs()
			.filter((j) => j.name.toLowerCase().includes(filter.trim().toLowerCase()))
			.sort((a, b) => a.name.localeCompare(b.name))
	);
</script>

<Modal {open} title="Pin a job" dismissable onclose={oncancel} maxWidth={440}>
	<input
		class="filter"
		type="search"
		placeholder="Filter jobs"
		aria-label="Filter jobs"
		bind:value={filter}
	/>
	{#if jobs.length === 0}
		<p class="muted">No jobs match.</p>
	{:else}
		<ul>
			{#each jobs as job (job.id)}
				<li>
					<button onclick={() => onpick(job.id)}>
						<span class="name">{job.name}</span>
						<span class="type">{getJobType(job.job_type)?.label ?? job.job_type}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</Modal>

<style>
	.filter {
		width: 100%;
		box-sizing: border-box;
		margin-bottom: 8px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 50vh;
		overflow-y: auto;
	}

	li button {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		border: none;
		border-radius: 4px;
		background: none;
		color: var(--text-primary);
		text-align: left;
		cursor: pointer;
		font-size: 0.875rem;
	}

	li button:hover {
		background: var(--bg-secondary);
	}

	.type,
	.muted {
		color: var(--text-secondary);
	}

	.type {
		flex-shrink: 0;
		font-size: 0.8rem;
	}
</style>
