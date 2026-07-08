<script lang="ts">
	import type { SearchStep } from '$lib/agent/loop';
	import { stepLabel, stepIcon } from './searchStepLabels';
	import hljs from 'highlight.js/lib/core';
	import python from 'highlight.js/lib/languages/python';
	import { rerunSandboxStep, cancelActiveSandboxRun } from '$lib/stores/chat.svelte';
	import { createKeyedCopyAction } from '$lib/utils/clipboard.svelte';
	import { isToolErrorResult } from '$lib/agent/tools/_helpers';
	import { sanitizeHtml } from '$lib/sanitize';
	import ImageViewerModal from './ImageViewerModal.svelte';

	hljs.registerLanguage('python', python);

	let viewerSrc = $state<string | null>(null);
	let viewerAlt = $state<string>('image');

	function openViewer(src: string, alt: string, event: MouseEvent) {
		event.stopPropagation();
		viewerSrc = src;
		viewerAlt = alt;
	}

	function closeViewer() {
		viewerSrc = null;
	}

	interface Props {
		steps: SearchStep[];
		slowMode?: boolean;
	}

	let { steps, slowMode = false }: Props = $props();

	function rerunStep(step: SearchStep, event: MouseEvent) {
		event.stopPropagation();
		void rerunSandboxStep(step.id);
	}

	function cancelStep(event: MouseEvent) {
		event.stopPropagation();
		cancelActiveSandboxRun();
	}

	const copyAction = createKeyedCopyAction();
	function copyLabel(key: string): string {
		const s = copyAction.state(key);
		return s === 'copied' ? 'Copied!' : s === 'failed' ? 'Failed' : 'Copy';
	}
	// Per-step user override for run_python code-block visibility. Absent
	// entry → use the default (collapsed if the run errored, expanded
	// otherwise) so the user doesn't have to scroll past 4 failing tries
	// before reaching the one that worked.
	let codeCollapsed: Record<string, boolean> = $state({});
	// Per-step accordion state for tool-result details. Click a step row
	// to toggle just that step's log open/closed.
	let detailsExpanded: Record<string, boolean> = $state({});

	function toggleDetails(step: SearchStep) {
		if (!step.result) return; // nothing to show yet
		detailsExpanded[step.id] = !detailsExpanded[step.id];
	}

	function stepErrored(step: SearchStep): boolean {
		if (step.status !== 'done') return false;
		if (step.lintIssues && step.lintIssues.length > 0) return true;
		// Most tools report failure as a {"error": ...} envelope, which the
		// old 'Error:'-prefix check missed — failed steps showed a green ✓.
		return isToolErrorResult(step.result);
	}

	function lintSummary(step: SearchStep): string {
		const issues = step.lintIssues;
		if (!issues || issues.length === 0) return '';
		if (issues.length === 1) {
			const i = issues[0];
			return `⚠ ${i.code} line ${i.line}: ${i.message}`;
		}
		const uniqCodes = Array.from(new Set(issues.map((i) => i.code))).slice(0, 4);
		return `⚠ ${issues.length} lint issues (${uniqCodes.join(', ')})`;
	}

	function isCodeCollapsed(step: SearchStep): boolean {
		if (step.id in codeCollapsed) return codeCollapsed[step.id];
		return stepErrored(step);
	}

	function toggleCode(step: SearchStep, event: MouseEvent) {
		event.stopPropagation();
		codeCollapsed[step.id] = !isCodeCollapsed(step);
	}

	function highlightPython(code: string): string {
		try {
			return hljs.highlight(code, { language: 'python' }).value;
		} catch {
			return code.replace(/[&<>"']/g, (c) => {
				const map: Record<string, string> = {
					'&': '&amp;',
					'<': '&lt;',
					'>': '&gt;',
					'"': '&quot;',
					"'": '&#39;'
				};
				return map[c];
			});
		}
	}

	function copyResult(stepId: string, text: string, event: MouseEvent) {
		event.stopPropagation();
		copyAction.copy(stepId, text);
	}

	// Upper bound on artifact HTML we'll inject into the DOM (srcdoc iframe or
	// {@html}). A normal interactive plot is a few MB (the bundled plotly.js +
	// data); a runaway figure embedding a large dataset can balloon past what
	// WebKitGTK will parse, blanking the whole webview ("white screen") with no
	// way to recover. Beyond this cap we show a placeholder instead of crashing.
	const MAX_ARTIFACT_HTML_BYTES = 16 * 1024 * 1024;

	function artifactTooLarge(html: string | undefined): boolean {
		return typeof html === 'string' && html.length > MAX_ARTIFACT_HTML_BYTES;
	}

	function artifactSizeLabel(html: string | undefined): string {
		const mb = (html?.length ?? 0) / (1024 * 1024);
		return `${mb.toFixed(1)} MB`;
	}
</script>

{#if steps.length > 0}
	<div class="search-steps">
		{#if slowMode}
			<div class="slow-notice">
				⏳ Deep research is using slow pacing — public search engines need to be rate-limited to
				avoid bot detection. For faster results, configure Brave Search or SearXNG in Settings.
			</div>
		{/if}
		{#each steps as step (step.id)}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="step"
				class:has-details={!!step.result}
				class:expanded={detailsExpanded[step.id]}
				class:errored={stepErrored(step)}
				data-status={step.status}
				onclick={() => toggleDetails(step)}
				title={step.result ? (detailsExpanded[step.id] ? 'Hide log' : 'Show log') : ''}
			>
				<span class="step-icon">{stepIcon(step.toolName)}</span>
				<span class="step-label">
					{stepLabel(step.toolName, step.query)}
					{#if step.lintIssues && step.lintIssues.length > 0}
						<span class="lint-summary">{lintSummary(step)}</span>
					{/if}
				</span>
				<span class="step-chevron">
					{#if step.result}{detailsExpanded[step.id] ? '▾' : '▸'}{/if}
				</span>
				{#if step.status === 'running' && step.installStatus}
					<span
						class="install-status"
						title="Downloading a package — this can take a moment on first use"
					>
						{step.installStatus}
					</span>
				{/if}
				<span class="step-status">
					{#if step.status === 'running'}
						<span class="spinner"></span>
					{:else if stepErrored(step)}
						<span class="status-err" title="errored">✕</span>
					{:else}
						&#10003;
					{/if}
				</span>
			</div>
			{#if step.toolName === 'run_python' && typeof step.args?.code === 'string'}
				<!--
					Collapse the code-controls + code block by default on errored
					runs so a chain of "tried this, failed; tried that, failed"
					attempts doesn't visually drown the conversation. The full
					detail is one click away (toggle the step row). Running and
					successful steps keep the existing inline layout.
				-->
				{#if step.status === 'running' || !stepErrored(step) || detailsExpanded[step.id]}
					<div class="code-controls">
						<button
							class="code-toggle"
							class:errored={stepErrored(step)}
							onclick={(e) => toggleCode(step, e)}
							title={isCodeCollapsed(step) ? 'Show code' : 'Hide code'}
						>
							{isCodeCollapsed(step) ? '▸' : '▾'} code
						</button>
						<button
							class="copy-btn"
							onclick={(e) => copyResult(`${step.id}:code`, step.args!.code as string, e)}
						>
							{copyLabel(`${step.id}:code`)}
						</button>
						{#if step.status === 'running'}
							<button
								class="run-control cancel"
								onclick={cancelStep}
								title="Terminate the Python worker for this chat"
							>
								⏸ Cancel
							</button>
						{:else if stepErrored(step)}
							<button
								class="run-control rerun"
								onclick={(e) => rerunStep(step, e)}
								title="Run the same code again in a fresh attempt"
							>
								▶ Run again
							</button>
						{/if}
					</div>
					{#if !isCodeCollapsed(step)}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="step-code" onclick={(e) => e.stopPropagation()}>
							<pre><code class="language-python"
									>{@html highlightPython(step.args.code as string)}</code
								></pre>
						</div>
					{/if}
				{/if}
			{/if}
			{#if step.thumbDataUrl}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="step-thumb" onclick={(e) => e.stopPropagation()}>
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<img
						src={step.thumbDataUrl}
						alt={step.query}
						class="clickable"
						title="Click to enlarge"
						onclick={(e) => openViewer(step.thumbDataUrl!, step.query, e)}
					/>
				</div>
			{/if}
			{#if step.artifacts && step.artifacts.length > 0}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="step-artifacts" onclick={(e) => e.stopPropagation()}>
					{#each step.artifacts as artifact, i (i)}
						{#if artifact.kind === 'image'}
							<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
							<img
								class="artifact-image clickable"
								src={artifact.dataUrl}
								alt={artifact.alt ?? 'plot'}
								title="Click to enlarge"
								onclick={(e) => openViewer(artifact.dataUrl, artifact.alt ?? 'plot', e)}
							/>
						{:else if artifactTooLarge(artifact.html)}
							<!--
								Refuse to inject an oversized artifact: parsing it in WebKitGTK
								can blank the entire webview with no recovery. Show a placeholder
								instead so the chat stays alive.
							-->
							<div class="artifact-toolarge">
								⚠ Plot too large to display ({artifactSizeLabel(artifact.html)}). Ask for a smaller
								figure (fewer points, or save it to a file instead of rendering inline).
							</div>
						{:else if artifact.interactive}
							<!--
								Interactive HTML (plotly / bokeh / altair / folium output) renders
								inside a sandboxed srcdoc iframe so the browser loads it as a fresh
								document and executes the embedded <script> tags natively. sandbox=
								"allow-scripts" lets the chart's JS run but no allow-same-origin →
								the iframe can't reach the parent.
							-->
							<iframe
								class="artifact-iframe"
								srcdoc={artifact.html}
								sandbox="allow-scripts"
								title="interactive plot"
							></iframe>
						{:else}
							<div class="artifact-html">
								{#if artifact.truncated}
									<div class="artifact-truncation-note">
										Showing {artifact.truncated.shown} of {artifact.truncated.total} rows
									</div>
								{/if}
								<!-- NOT trusted: the Python that produced this HTML is model-authored,
								     and the model's context includes fetched web content. A crafted
								     _repr_html_ without a <script> tag (e.g. <img onerror>) would
								     otherwise execute here in the privileged webview — only the
								     `interactive` branch above is isolated in a sandboxed iframe. -->
								<!-- eslint-disable-next-line svelte/no-at-html-tags -->
								{@html sanitizeHtml(artifact.html)}
							</div>
						{/if}
					{/each}
				</div>
			{/if}
			{#if detailsExpanded[step.id] && step.result}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="detail-block" onclick={(e) => e.stopPropagation()}>
					<div class="detail-header">
						<div class="detail-label">{step.toolName}: {step.query}</div>
						<button class="copy-btn" onclick={(e) => copyResult(step.id, step.result ?? '', e)}>
							{copyLabel(step.id)}
						</button>
					</div>
					<pre>{step.result}</pre>
				</div>
			{/if}
		{/each}
	</div>
{/if}

<ImageViewerModal src={viewerSrc} alt={viewerAlt} onClose={closeViewer} />

<style>
	.search-steps {
		padding: 8px 16px;
		border-bottom: 1px solid var(--border);
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
		padding: 4px 4px;
		margin: 0 -4px;
		border-radius: 4px;
		color: var(--text-secondary);
	}

	.step[data-status='done'] {
		color: var(--text-primary);
	}

	.step.has-details {
		cursor: pointer;
	}

	.step.has-details:hover {
		background: var(--bg-secondary);
	}

	.step.expanded {
		background: var(--bg-secondary);
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

	.step-chevron {
		flex-shrink: 0;
		font-size: 0.75rem;
		color: var(--text-secondary);
		min-width: 10px;
	}

	.step-status {
		flex-shrink: 0;
		color: var(--success);
	}

	.status-err {
		color: #c97;
		font-weight: 600;
	}

	.step.errored .step-label {
		color: var(--text-secondary);
	}

	.lint-summary {
		margin-left: 8px;
		padding: 1px 6px;
		font-size: 0.72rem;
		color: #c97;
		background: rgba(204, 153, 119, 0.1);
		border-radius: 3px;
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
	}

	.install-status {
		margin-left: auto;
		padding: 1px 8px;
		font-size: 0.72rem;
		color: var(--text-secondary);
		background: rgba(120, 160, 220, 0.12);
		border-radius: 3px;
		white-space: nowrap;
	}

	.step-thumb {
		margin: 4px 0 8px 26px; /* align under the step-label */
		cursor: default;
	}

	.step-thumb img {
		max-width: 240px;
		max-height: 180px;
		border-radius: 6px;
		border: 1px solid var(--border);
		display: block;
		object-fit: contain;
	}

	.code-controls {
		margin: 0 16px 4px 26px;
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.code-toggle {
		padding: 2px 8px;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-family: inherit;
		cursor: pointer;
	}

	.code-toggle:hover {
		background: var(--bg-secondary);
	}

	.code-toggle.errored {
		color: var(--error-text);
	}

	.step-code {
		margin: 4px 16px 8px 26px;
		cursor: default;
	}

	.step-code pre {
		margin: 0;
		padding: 10px 12px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: auto;
		max-height: 320px;
		font-size: 0.82rem;
		line-height: 1.45;
	}

	.step-code code {
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		white-space: pre;
	}

	.step-artifacts {
		margin: 4px 16px 8px 26px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		cursor: default;
	}

	.artifact-image {
		max-width: 100%;
		max-height: 480px;
		border-radius: 6px;
		border: 1px solid var(--border);
		display: block;
		object-fit: contain;
		background: white;
	}

	.clickable {
		cursor: zoom-in;
		transition: opacity 0.12s;
	}
	.clickable:hover {
		opacity: 0.9;
	}

	.artifact-iframe {
		width: 100%;
		height: 480px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: white;
	}

	.artifact-html {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 8px 12px;
		overflow: auto;
		max-height: 480px;
		background: var(--surface, transparent);
		font-size: 0.9em;
	}

	.artifact-html :global(table) {
		border-collapse: collapse;
		font-size: 0.85em;
	}
	.artifact-html :global(th),
	.artifact-html :global(td) {
		border: 1px solid var(--border);
		padding: 2px 8px;
		text-align: right;
	}
	.artifact-html :global(th) {
		background: rgba(127, 127, 127, 0.1);
		font-weight: 600;
	}

	.artifact-truncation-note {
		font-size: 0.8em;
		color: var(--text-muted, #888);
		margin-bottom: 4px;
	}

	.artifact-toolarge {
		border: 1px solid var(--error-border, #c97);
		border-radius: 6px;
		padding: 10px 12px;
		font-size: 0.82rem;
		line-height: 1.4;
		color: var(--error-text, #c97);
		background: var(--error-bg, rgba(204, 153, 119, 0.08));
	}

	/* Size override of the global .spinner — fits the step-status slot. */
	.spinner {
		width: 12px;
		height: 12px;
	}

	.detail-block {
		margin: 4px 16px 8px 26px;
	}

	.detail-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 4px;
	}

	.detail-label {
		font-weight: 500;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.copy-btn {
		background: none;
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 2px 8px;
		font-size: 0.7rem;
		cursor: pointer;
		color: var(--text-secondary);
	}

	.copy-btn:hover {
		background: var(--bg-primary);
	}

	.run-control {
		background: none;
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 2px 8px;
		font-size: 0.7rem;
		cursor: pointer;
		color: var(--text-secondary);
	}
	.run-control:hover {
		background: var(--bg-primary);
	}
	.run-control.cancel {
		color: #c97;
		border-color: #c97;
	}
	.run-control.rerun {
		color: #6a6;
		border-color: #6a6;
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
