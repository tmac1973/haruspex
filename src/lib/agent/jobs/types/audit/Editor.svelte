<script lang="ts">
	import PromptCatalog from '$lib/components/jobs/PromptCatalog.svelte';
	import type { JobStepInput } from '$lib/stores/jobs.svelte';
	import { DEFAULT_SAMPLE_INSTRUCTIONS, DEFAULT_VERIFY_INSTRUCTIONS } from './auditPipeline';

	// The audit-specific section of the job editor. The audit prompt reuses
	// steps[0].prompt so the persistence path stays shared with research.
	let {
		steps = $bindable(),
		numRuns = $bindable(),
		outputFile = $bindable(),
		readOnly = $bindable(),
		maxTurns = $bindable(),
		sampleInstructions = $bindable(),
		verifyInstructions = $bindable()
	}: {
		steps: JobStepInput[];
		numRuns: number;
		outputFile: string;
		readOnly: boolean;
		maxTurns: number;
		sampleInstructions: string;
		verifyInstructions: string;
	} = $props();

	function updatePrompt(value: string) {
		const next = [...steps];
		next[0] = { ...(next[0] ?? { deep_research: false }), prompt: value };
		steps = next;
	}
</script>

<div class="field" title="The instruction each sample run executes, independently.">
	<div class="field-head">
		<span class="label">Audit prompt</span>
		<PromptCatalog jobType="audit" current={steps[0]?.prompt ?? ''} oninsert={updatePrompt} />
	</div>
	<span class="hint">
		Run {numRuns}× independently. Ask for findings anchored to files and line ranges.
	</span>
	<textarea
		value={steps[0]?.prompt ?? ''}
		oninput={(e) => updatePrompt((e.currentTarget as HTMLTextAreaElement).value)}
		placeholder="e.g. Find every instance of duplicated logic in this codebase. Anchor each finding to a file and line range, with a short explanation."
		rows="4"
	></textarea>
</div>

<div class="audit-grid">
	<label class="field" title="How many independent sample runs to execute (1–20).">
		<span class="label">Number of runs</span>
		<input type="number" min="1" max="20" bind:value={numRuns} />
	</label>
	<label
		class="field"
		title="Agent-loop turn budget per run — how many read/grep steps each sample may take before it must report. A thorough audit of a large codebase can need 100+. Default 200, max 400."
	>
		<span class="label">Max turns per run</span>
		<input type="number" min="1" max="400" step="10" bind:value={maxTurns} />
	</label>
	<label
		class="field span2"
		title="File (relative to the working directory) the final meta-report is written to. Leave blank to only keep it in the run record."
	>
		<span class="label">Output file <span class="optional">(optional)</span></span>
		<input type="text" bind:value={outputFile} placeholder="AUDIT.md" />
	</label>
</div>

<label
	class="field checkbox"
	title="When ON (recommended), sample and verification runs may read and grep the code but cannot modify files."
>
	<input type="checkbox" bind:checked={readOnly} />
	<span>
		Read-only runs
		<span class="hint inline">(recommended — sample runs read/grep but never modify files)</span>
	</span>
</label>

<details class="advanced-prompts">
	<summary>Advanced: edit the exact prompts sent to the model</summary>
	<p class="hint">
		Both are sent verbatim to the model. The <code>submit_findings</code> /
		<code>submit_verdict</code> calls are enforced automatically, so editing won't break capture —
		but a poor prompt can hurt result quality. Use <strong>Reset</strong> to restore the default.
	</p>

	<div class="field">
		<span class="label-row">
			<span class="label">Per-run addendum</span>
			<button
				type="button"
				class="reset-btn"
				disabled={sampleInstructions === DEFAULT_SAMPLE_INSTRUCTIONS}
				onclick={() => (sampleInstructions = DEFAULT_SAMPLE_INSTRUCTIONS)}
			>
				Reset
			</button>
		</span>
		<span class="hint">
			Appended after your audit prompt on every sample run (phase 1) — investigation guidance plus
			how to report findings.
		</span>
		<textarea bind:value={sampleInstructions} rows="6"></textarea>
	</div>

	<div class="field">
		<span class="label-row">
			<span class="label">Verification instructions</span>
			<button
				type="button"
				class="reset-btn"
				disabled={verifyInstructions === DEFAULT_VERIFY_INSTRUCTIONS}
				onclick={() => (verifyInstructions = DEFAULT_VERIFY_INSTRUCTIONS)}
			>
				Reset
			</button>
		</span>
		<span class="hint">
			Sent to the model that re-checks each finding against the source (phase 3) before it's kept;
			the finding's location/claim is prepended automatically.
		</span>
		<textarea bind:value={verifyInstructions} rows="8"></textarea>
	</div>
</details>

<style>
	.label {
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.optional {
		font-weight: normal;
		opacity: 0.7;
	}

	.hint {
		font-style: italic;
	}

	.hint.inline {
		font-style: normal;
		margin-left: 4px;
	}

	.field.checkbox {
		flex-direction: row;
		align-items: flex-start;
		gap: 8px;
		font-size: 0.88rem;
	}

	.audit-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	.audit-grid .span2 {
		grid-column: 1 / -1;
	}

	.field-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.advanced-prompts {
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 8px 10px;
	}

	.advanced-prompts > summary {
		cursor: pointer;
		font-size: 0.82rem;
		color: var(--text-secondary);
		user-select: none;
	}

	.advanced-prompts .field {
		margin-top: 10px;
	}

	.advanced-prompts code {
		font-size: 0.85em;
	}

	.label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.reset-btn {
		padding: 2px 8px;
		font-size: 0.72rem;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-secondary);
		border-radius: 4px;
		cursor: pointer;
	}

	.reset-btn:hover:not(:disabled) {
		border-color: var(--text-secondary);
		color: var(--text-primary);
	}

	.reset-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
