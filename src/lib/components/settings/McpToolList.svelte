<script lang="ts">
	/**
	 * Per-tool toggles for one server, with the budget warning above them.
	 *
	 * The warning sits here rather than at the top of the section because this
	 * is where the user can act on it: the sentence says "turn off the ones you
	 * do not need below", and below is this list.
	 */
	import type { McpToolDescriptor } from '$lib/ipc/gen/McpToolDescriptor';
	import { getToolSchemas } from '$lib/agent/tools';
	import { evaluateToolBudget } from '$lib/agent/mcp-budget';
	import { getSettings } from '$lib/stores/settings';

	interface Props {
		tools: McpToolDescriptor[];
		/** Explicit per-tool decisions; absent means "use the catalog default". */
		toolEnabled: Record<string, boolean>;
		/** The catalog entry's tested default list. */
		defaultTools: string[];
		onchange: (toolEnabled: Record<string, boolean>) => void;
	}

	const { tools, toolEnabled, defaultTools, onchange }: Props = $props();

	function isEnabled(name: string): boolean {
		const explicit = toolEnabled[name];
		return typeof explicit === 'boolean' ? explicit : defaultTools.includes(name);
	}

	function toggle(name: string): void {
		onchange({ ...toolEnabled, [name]: !isEnabled(name) });
	}

	/**
	 * Drop every explicit decision rather than writing the defaults out as
	 * explicit choices. A later catalog update that changes `defaultTools`
	 * should then be adopted, which it would not be if "reset" had pinned the
	 * old list.
	 */
	function resetToDefaults(): void {
		onchange({});
	}

	const hasOverrides = $derived(Object.keys(toolEnabled).length > 0);

	// Judged against the whole exposed toolset, not just this server's: the
	// model's context carries all of them, and a per-server count would call
	// three servers of ten tools each fine.
	const budget = $derived(
		evaluateToolBudget({
			schemas: getToolSchemas({ hasWorkingDir: false }),
			modelId: activeModelId(),
			modelLabel: activeModelId() ?? undefined
		})
	);

	/**
	 * The model the budget is judged against: the remote model id when a remote
	 * backend is selected, otherwise the local weights filename. Both carry the
	 * parameter count the cap keys off.
	 */
	function activeModelId(): string | null {
		const s = getSettings();
		return s.inferenceBackend.mode === 'local'
			? s.activeLocalModelFilename || null
			: s.inferenceBackend.remoteModelId || null;
	}

	function badges(tool: McpToolDescriptor): string[] {
		const a = tool.annotations;
		const out: string[] = [];
		if (a?.readOnlyHint === true) out.push('read-only');
		else out.push('asks first');
		if (a?.destructiveHint === true) out.push('destructive');
		if (a?.openWorldHint === true) out.push('external');
		return out;
	}
</script>

{#if budget.warning}
	<p class="budget-warning">{budget.warning}</p>
{/if}

{#if tools.length === 0}
	<p class="section-help">No tools discovered yet. Start the server to see what it offers.</p>
{:else}
	<ul class="tool-list">
		{#each tools as tool (tool.name)}
			<li>
				<label class="toggle-row">
					<input
						type="checkbox"
						checked={isEnabled(tool.name)}
						onchange={() => toggle(tool.name)}
					/>
					<span class="tool-name">{tool.title ?? tool.name}</span>
				</label>
				{#if tool.description}
					<p class="tool-description">{tool.description}</p>
				{/if}
				<p class="badges">
					{#each badges(tool) as badge (badge)}<span class="badge">{badge}</span>{/each}
				</p>
			</li>
		{/each}
	</ul>
	<button type="button" class="link-button" disabled={!hasOverrides} onclick={resetToDefaults}>
		Reset to the recommended set
	</button>
{/if}

<style>
	.budget-warning {
		border-left: 3px solid var(--warning, #d97706);
		padding-left: 0.75rem;
		font-size: 0.9em;
	}
	.tool-list {
		list-style: none;
		padding: 0;
		margin: 0.5rem 0;
	}
	.tool-list li {
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--border-subtle, #292524);
	}
	.tool-name {
		font-weight: 600;
	}
	.tool-description,
	.badges {
		margin: 0.15rem 0 0 1.75rem;
		font-size: 0.85em;
		color: var(--text-secondary, #a8a29e);
	}
	.badge {
		display: inline-block;
		margin-right: 0.4rem;
		padding: 0 0.4rem;
		border: 1px solid var(--border-subtle, #292524);
		border-radius: 3px;
	}
	.link-button {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent, #14b8a6);
		cursor: pointer;
	}
	.link-button:disabled {
		color: var(--text-secondary, #a8a29e);
		cursor: default;
	}
</style>
