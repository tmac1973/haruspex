<script lang="ts">
	// Placeholder for the Jobs tab. The job list, editor, run view, and run
	// history land in subsequent PRs (see plan/phase-14-jobs-tab.md).
</script>

<div class="jobs-tab">
	<div class="empty-state">
		<h2>Jobs</h2>
		<p>Saved prompts and multi-step pipelines will live here.</p>
		<p class="hint">Coming soon.</p>
	</div>
</div>

<style>
	.jobs-tab {
		flex: 1;
		min-height: 0;
		display: flex;
		overflow: hidden;
	}

	.empty-state {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
		text-align: center;
		padding: 32px;
	}

	.empty-state h2 {
		margin: 0 0 8px 0;
		font-size: 1.2rem;
		color: var(--text-primary);
	}

	.empty-state p {
		margin: 0 0 4px 0;
	}

	.hint {
		font-size: 0.85rem;
		font-style: italic;
	}
</style>
