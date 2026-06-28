<script lang="ts">
	/**
	 * Modal for the reusable ask_user_question primitive. Mounted once in the
	 * root layout — subscribes to the userQuestion store and opens whenever a
	 * question is pending.
	 *
	 * Supports the full question shape: single- or multi-select options (each
	 * with an optional description and a "recommended" highlight) plus an
	 * always-present free-text answer. Selecting options and typing free text
	 * are mutually exclusive — whichever the user touches last wins.
	 *
	 * Backdrop/Esc do NOT dismiss: a pending question must be answered.
	 * Cancellation is the run's concern (job-cancel), not the modal's.
	 */
	import Modal from './Modal.svelte';
	import { getPendingQuestion, resolveUserQuestion } from '$lib/stores/userQuestion.svelte';

	const pending = $derived(getPendingQuestion());

	let selected = $state<string[]>([]);
	let freeText = $state('');
	// Identity of the question the local form state belongs to; used to reset
	// the form when a different question becomes pending (the modal instance is
	// reused across questions).
	let formFor = $state<unknown>(null);

	$effect(() => {
		if (pending !== formFor) {
			formFor = pending;
			selected = [];
			freeText = '';
		}
	});

	function toggle(label: string) {
		const p = pending;
		if (!p) return;
		// Picking an option supersedes any free-text the user started.
		freeText = '';
		if (p.allowMultiple) {
			selected = selected.includes(label)
				? selected.filter((l) => l !== label)
				: [...selected, label];
		} else {
			selected = [label];
		}
	}

	function onFreeInput() {
		// Typing a custom answer supersedes any selected options.
		if (freeText.trim().length > 0) selected = [];
	}

	const canSubmit = $derived(selected.length > 0 || freeText.trim().length > 0);

	function submit() {
		if (!pending || !canSubmit) return;
		if (selected.length > 0) {
			resolveUserQuestion({ kind: 'selected', labels: selected });
		} else {
			resolveUserQuestion({ kind: 'freeText', text: freeText.trim() });
		}
	}
</script>

<Modal open={pending != null} maxWidth={580} labelledBy="user-question-title">
	{#if pending}
		<h2 id="user-question-title">{pending.question}</h2>
		{#if pending.allowMultiple}
			<p class="hint">Select one or more.</p>
		{/if}

		<div class="options">
			{#each pending.options as opt (opt.label)}
				<button
					type="button"
					class="option"
					class:selected={selected.includes(opt.label)}
					onclick={() => toggle(opt.label)}
				>
					<span class="marker" class:multi={pending.allowMultiple} aria-hidden="true"></span>
					<span class="body">
						<span class="label">
							{opt.label}
							{#if opt.recommended}<span class="badge">Recommended</span>{/if}
						</span>
						{#if opt.description}<span class="desc">{opt.description}</span>{/if}
					</span>
				</button>
			{/each}
		</div>

		<label class="free">
			<span class="free-title">Write your own answer</span>
			<textarea
				rows="2"
				placeholder="Type a different answer…"
				bind:value={freeText}
				oninput={onFreeInput}
			></textarea>
		</label>

		<div class="actions">
			<button type="button" class="submit" disabled={!canSubmit} onclick={submit}>Submit</button>
		</div>
	{/if}
</Modal>

<style>
	h2 {
		margin: 0 0 4px;
		font-size: 1.05rem;
		line-height: 1.35;
	}

	.hint {
		margin: 0 0 8px;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.options {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 12px;
	}

	.option {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		text-align: left;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		transition:
			border-color 0.15s,
			background 0.15s;
	}

	.option:hover {
		border-color: var(--accent);
	}

	.option.selected {
		border-color: var(--accent);
		background: var(--bg-secondary);
	}

	.marker {
		flex: 0 0 auto;
		width: 16px;
		height: 16px;
		margin-top: 2px;
		border: 1px solid var(--border);
		border-radius: 50%;
		transition:
			border-color 0.15s,
			background 0.15s;
	}

	.marker.multi {
		border-radius: 4px;
	}

	.option.selected .marker {
		border-color: var(--accent);
		background: var(--accent);
		box-shadow: inset 0 0 0 3px var(--bg-primary);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.label {
		font-size: 0.92rem;
		font-weight: 500;
	}

	.badge {
		margin-left: 6px;
		padding: 1px 6px;
		border-radius: 999px;
		font-size: 0.68rem;
		font-weight: 600;
		vertical-align: middle;
		color: var(--accent);
		background: var(--bg-secondary);
		border: 1px solid var(--accent);
	}

	.desc {
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.free {
		display: block;
		margin-top: 16px;
	}

	.free-title {
		display: block;
		font-size: 0.78rem;
		color: var(--text-secondary);
		margin-bottom: 4px;
	}

	textarea {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font: inherit;
		font-size: 0.86rem;
	}

	textarea:focus {
		outline: none;
		border-color: var(--accent);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 16px;
	}

	.submit {
		padding: 8px 18px;
		border: 1px solid var(--accent);
		border-radius: 8px;
		background: var(--accent);
		color: var(--bg-primary);
		font-size: 0.88rem;
		font-weight: 500;
		cursor: pointer;
	}

	.submit:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
