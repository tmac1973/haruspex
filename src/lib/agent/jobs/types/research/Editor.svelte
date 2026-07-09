<script lang="ts">
	import PromptCatalog from '$lib/components/jobs/PromptCatalog.svelte';
	import type { JobStepInput } from '$lib/stores/jobs.svelte';

	// The research-specific section of the job editor: the step-pipeline list.
	// `steps` stays owned by JobEditor (audit shares steps[0] as its prompt and
	// the save path persists it) — this component only edits it in place.
	let { steps = $bindable() }: { steps: JobStepInput[] } = $props();

	function addStep() {
		steps = [...steps, { prompt: '', deep_research: false }];
	}

	function removeStep(index: number) {
		if (steps.length === 1) {
			steps = [{ prompt: '', deep_research: false }];
			return;
		}
		steps = steps.filter((_, i) => i !== index);
	}

	function moveStep(index: number, direction: -1 | 1) {
		const target = index + direction;
		if (target < 0 || target >= steps.length) return;
		const next = [...steps];
		[next[index], next[target]] = [next[target], next[index]];
		steps = next;
	}

	function updateStepPrompt(index: number, value: string) {
		const next = [...steps];
		next[index] = { ...next[index], prompt: value };
		steps = next;
	}

	function toggleStepDeepResearch(index: number) {
		const next = [...steps];
		next[index] = { ...next[index], deep_research: !next[index].deep_research };
		steps = next;
	}
</script>

<div
	class="field steps"
	title="Each step is one prompt that runs as a fresh conversation with the model — no history between steps. The previous step's final reply is automatically prepended to the next step's prompt, so step 2 can act on step 1's output. Use this to decompose multi-objective work that a small model struggles to do in one shot."
>
	<div class="steps-header">
		<span class="label">Steps</span>
		<span class="hint">
			Each step runs in a fresh conversation. The previous step's output is automatically prepended
			to the next step's prompt.
		</span>
	</div>
	{#each steps as step, i (i)}
		<div class="step">
			<div class="step-head">
				<div class="step-head-left">
					<span class="step-num">Step {i + 1}</span>
					<button
						type="button"
						class="research-toggle"
						class:active={step.deep_research}
						onclick={() => toggleStepDeepResearch(i)}
						title={step.deep_research
							? 'Deep research ON — this step will search more sources'
							: 'Deep research OFF — normal search for this step'}
						aria-pressed={step.deep_research}
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<circle cx="11" cy="11" r="8"></circle>
							<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
							{#if step.deep_research}
								<line x1="11" y1="8" x2="11" y2="14"></line>
								<line x1="8" y1="11" x2="14" y2="11"></line>
							{/if}
						</svg>
						<span>Deep research</span>
					</button>
				</div>
				<div class="step-actions">
					<PromptCatalog
						jobType="research"
						current={step.prompt}
						oninsert={(t) => updateStepPrompt(i, t)}
					/>
					<button
						type="button"
						class="icon-btn"
						title="Move up"
						disabled={i === 0}
						onclick={() => moveStep(i, -1)}
					>
						↑
					</button>
					<button
						type="button"
						class="icon-btn"
						title="Move down"
						disabled={i === steps.length - 1}
						onclick={() => moveStep(i, 1)}
					>
						↓
					</button>
					<button
						type="button"
						class="icon-btn danger"
						title="Remove step"
						onclick={() => removeStep(i)}
					>
						×
					</button>
				</div>
			</div>
			<textarea
				value={step.prompt}
				oninput={(e) => updateStepPrompt(i, (e.currentTarget as HTMLTextAreaElement).value)}
				placeholder={i === 0
					? 'What should this step do?'
					: 'Will receive the previous step’s output as context.'}
				title={i === 0
					? 'Plain instruction for this step. The model sees this verbatim as the user message in a fresh chat with full tool access (search, file ops, Python sandbox).'
					: "Plain instruction. At run time the previous step's reply is automatically prepended, so you can write this assuming the prior output is already in front of the model (e.g. 'Turn the above headlines into a PDF')."}
				rows="3"
			></textarea>
		</div>
	{/each}
	<button
		type="button"
		class="btn add-step"
		onclick={addStep}
		title="Add another step to the pipeline. Runs after the previous step completes."
	>
		+ Add step
	</button>
</div>

<style>
	.label {
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.hint {
		font-style: italic;
	}

	.steps-header {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-bottom: 4px;
	}

	.step {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
	}

	.step-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
	}

	.step-head-left {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.step-num {
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.research-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-secondary);
		border-radius: 999px;
		font-size: 0.72rem;
		cursor: pointer;
	}

	.research-toggle:hover {
		color: var(--text-primary);
		border-color: var(--text-secondary);
	}

	.research-toggle.active {
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		border-color: var(--accent);
		color: var(--accent);
	}

	.step-actions {
		display: flex;
		gap: 2px;
	}

	.icon-btn {
		width: 24px;
		height: 24px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-secondary);
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.85rem;
		line-height: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.icon-btn:hover:not(:disabled) {
		color: var(--text-primary);
		border-color: var(--text-secondary);
	}

	.icon-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.icon-btn.danger:hover:not(:disabled) {
		color: var(--error-text);
		border-color: var(--error-border);
		background: var(--error-bg);
	}

	.add-step {
		align-self: flex-start;
	}
</style>
