<script lang="ts">
	import type { SearchStep } from '$lib/agent/loop';

	interface Props {
		steps: SearchStep[];
		slowMode?: boolean;
	}

	let { steps, slowMode = false }: Props = $props();
	let expanded = $state(false);

	function stepIcon(toolName: string): string {
		if (toolName === 'web_search') return '\u{1F50D}'; // magnifying glass
		if (toolName === 'research_url') return '\u{1F9D0}'; // face with monocle
		if (toolName.startsWith('fs_write')) return '\u{1F4DD}'; // memo
		if (toolName.startsWith('fs_list')) return '\u{1F4C2}'; // open folder
		if (toolName.startsWith('fs_edit')) return '\u270F\uFE0F'; // pencil
		return '\u{1F4C4}'; // generic document
	}

	function stepLabel(toolName: string, query: string): string {
		switch (toolName) {
			case 'web_search':
				return `Searching: "${query}"`;
			case 'fetch_url':
				return `Reading: ${query}`;
			case 'research_url':
				return `Researching: ${query}`;
			case 'fs_list_dir':
				return `Listing: ${query}`;
			case 'fs_read_text':
				return `Reading: ${query}`;
			case 'fs_read_pdf':
				return `Reading PDF: ${query}`;
			case 'fs_read_pdf_pages':
				return `Rendering PDF pages: ${query}`;
			case 'fs_read_docx':
				return `Reading docx: ${query}`;
			case 'fs_read_xlsx':
				return `Reading xlsx: ${query}`;
			case 'fs_read_image':
				return `Viewing image: ${query}`;
			case 'fs_write_text':
				return `Writing: ${query}`;
			case 'fs_write_docx':
				return `Writing docx: ${query}`;
			case 'fs_write_pdf':
				return `Writing pdf: ${query}`;
			case 'fs_write_xlsx':
				return `Writing xlsx: ${query}`;
			case 'fs_edit_text':
				return `Editing: ${query}`;
			default:
				return `${toolName}: ${query}`;
		}
	}
</script>

{#if steps.length > 0}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="search-steps" onclick={() => (expanded = !expanded)}>
		{#if slowMode}
			<div class="slow-notice">
				⏳ Deep research is using slow pacing — public search engines need to be
				rate-limited to avoid bot detection. For faster results, configure
				Brave Search or SearXNG in Settings.
			</div>
		{/if}
		{#each steps as step (step.id)}
			<div class="step" data-status={step.status}>
				<span class="step-icon">{stepIcon(step.toolName)}</span>
				<span class="step-label">{stepLabel(step.toolName, step.query)}</span>
				<span class="step-status">
					{#if step.status === 'running'}
						<span class="spinner"></span>
					{:else}
						&#10003;
					{/if}
				</span>
			</div>
		{/each}

		{#if expanded}
			<div class="step-details">
				{#each steps as step (step.id)}
					{#if step.result}
						<div class="detail-block">
							<div class="detail-label">{step.toolName}: {step.query}</div>
							<pre>{step.result}</pre>
						</div>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.search-steps {
		padding: 8px 16px;
		border-bottom: 1px solid var(--border);
		cursor: pointer;
		font-size: 0.85rem;
	}

	.slow-notice {
		margin-bottom: 8px;
		padding: 8px 10px;
		font-size: 0.78rem;
		line-height: 1.4;
		color: var(--text-primary);
		background: var(--bg-secondary);
		border-left: 3px solid var(--accent);
		border-radius: 4px;
	}

	.step {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		color: var(--text-secondary);
	}

	.step[data-status='done'] {
		color: var(--text-primary);
	}

	.step-icon {
		font-size: 0.9rem;
		flex-shrink: 0;
	}

	.step-label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.step-status {
		flex-shrink: 0;
		color: #22c55e;
	}

	.spinner {
		display: inline-block;
		width: 12px;
		height: 12px;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.step-details {
		margin-top: 8px;
		border-top: 1px solid var(--border);
		padding-top: 8px;
	}

	.detail-block {
		margin-bottom: 8px;
	}

	.detail-label {
		font-weight: 500;
		font-size: 0.75rem;
		margin-bottom: 4px;
		color: var(--text-secondary);
	}

	.detail-block pre {
		margin: 0;
		padding: 8px;
		background: var(--code-bg);
		color: #d4d4d4;
		border-radius: 4px;
		font-size: 0.75rem;
		overflow-x: auto;
		max-height: 150px;
		overflow-y: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
