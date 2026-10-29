<script lang="ts">
	/**
	 * Settings → Inference → Model defaults: how the model reasons and how long
	 * a reply may be, for every tab. These moved here from the old Settings →
	 * Agent, which was otherwise Chat-only; the keys kept their names.
	 */
	import {
		getSettings,
		updateSettings,
		clampResponseTokens,
		DEFAULT_MAX_RESPONSE_TOKENS,
		DEFAULT_MAX_RESPONSE_TOKENS_FILE_WRITE,
		MIN_MAX_RESPONSE_TOKENS,
		MAX_MAX_RESPONSE_TOKENS
	} from '#lib/stores/settings.ts';
	import { KNOWN_EFFORT_LEVELS, resolveBackendDescriptor } from '#lib/inference/descriptor.ts';

	let thinkingEnabled = $state(getSettings().thinkingEnabled);
	// The active backend may report that its model has no reasoning mode (an
	// llama-toolchest non-reasoning model); hide the toggle in that case since
	// it would have no effect. Local + other remote backends are assumed
	// capable. Snapshot at mount, matching the rest of Settings.
	let reasoningSupported = $state(resolveBackendDescriptor().reasoningSupported);
	// Effort levels are the model's own vocabulary — Qwen 3.8 takes
	// low/medium/xhigh, most OpenRouter models none/low/medium/high. When the
	// active model publishes a vocabulary those are the only options offered;
	// otherwise we fall back to the known union so the user can still set a
	// standing preference. The control is always visible: hiding it whenever
	// the current backend has no effort axis is indistinguishable from the
	// feature not existing.
	let effortCaps = $state(resolveBackendDescriptor().reasoningEffort);
	let reasoningEffort = $state(getSettings().reasoningEffort);
	let maxResponseTokens = $state(getSettings().maxResponseTokens);
	let maxResponseTokensFileWrite = $state(getSettings().maxResponseTokensFileWrite);

	const effortOptions = $derived.by(() => {
		const levels = effortCaps?.levels ?? KNOWN_EFFORT_LEVELS;
		// A level chosen for a different model must stay visible and selected
		// rather than silently reading as "Model default" — it IS still the
		// stored preference, it just doesn't reach this backend.
		return reasoningEffort && !levels.includes(reasoningEffort)
			? [...levels, reasoningEffort]
			: levels;
	});

	/** Whether the stored level actually reaches the active model. */
	const effortApplies = $derived(
		!reasoningEffort || (effortCaps?.levels.includes(reasoningEffort) ?? false)
	);

	/**
	 * Persist a response-token cap, clamped to the supported range. Clamping
	 * rather than rejecting: an out-of-range entry snaps to the nearest bound
	 * and the snapped value is what shows and persists, so the field can never
	 * be left holding a number the agent loop won't actually use.
	 */
	function onTokensChange(
		key: 'maxResponseTokens' | 'maxResponseTokensFileWrite',
		raw: string
	): void {
		const parsed = Number.parseInt(raw, 10);
		const fallback =
			key === 'maxResponseTokens'
				? DEFAULT_MAX_RESPONSE_TOKENS
				: DEFAULT_MAX_RESPONSE_TOKENS_FILE_WRITE;
		const clamped = clampResponseTokens(Number.isNaN(parsed) ? fallback : parsed);
		if (key === 'maxResponseTokens') maxResponseTokens = clamped;
		else maxResponseTokensFileWrite = clamped;
		updateSettings({ [key]: clamped });
	}

	function toggleThinkingEnabled() {
		thinkingEnabled = !thinkingEnabled;
		updateSettings({ thinkingEnabled });
	}

	function setReasoningEffort(value: string) {
		reasoningEffort = value || null;
		updateSettings({ reasoningEffort });
	}
</script>

<section class="settings-section">
	<h2>Model defaults</h2>
	<p class="hint">How the model reasons and how long a reply may be, in every tab.</p>
	{#if reasoningSupported}
		<label
			class="toggle-row"
			title="The model thinks before it answers. Better on code and multi-step tasks, at the cost of more tokens per turn. Each Shell tab's Think toggle starts from this, and a job can set its own."
		>
			<input type="checkbox" checked={thinkingEnabled} onchange={toggleThinkingEnabled} />
			<div>
				<strong>Reasoning mode</strong>
				<span>Let the model think before it answers.</span>
			</div>
		</label>
	{/if}
	<div
		class="effort"
		title="A lower level tells the model up front to keep its thinking short, so nothing is cut off part-way. Thinking uses the same context window as the work, so a high level can run a long coding turn out of room. A Code session or a job can set its own."
	>
		<label for="reasoning-effort">Reasoning effort:</label>
		<select
			id="reasoning-effort"
			value={reasoningEffort ?? ''}
			onchange={(e) => setReasoningEffort(e.currentTarget.value)}
			disabled={!thinkingEnabled}
		>
			<option value=""
				>Model default{effortCaps?.modelDefault ? ` (${effortCaps.modelDefault})` : ''}</option
			>
			{#each effortOptions as level (level)}
				<option value={level}>{level}</option>
			{/each}
		</select>
		<p class="hint">
			{#if !thinkingEnabled}
				Only applies while reasoning mode is on.
			{:else if !effortCaps}
				The active model takes no effort level; it applies where one is understood.
			{:else if !effortApplies}
				The active model accepts only {effortCaps.levels.join(', ')}, so it uses its own default ({effortCaps.modelDefault ??
					'unspecified'}) until you pick one of those.
			{:else}
				How long the model thinks before answering.
			{/if}
		</p>
	</div>
	<label
		class="tokens-row"
		title="Chat, the Shell's Read-only assistant, jobs and quick one-off replies. Separate from Context Size, which bounds the whole conversation. {MIN_MAX_RESPONSE_TOKENS}–{MAX_MAX_RESPONSE_TOKENS}."
	>
		<span class="tokens-label">
			Max response tokens
			<span class="tokens-sub">The longest a single reply may be.</span>
		</span>
		<input
			type="number"
			min={MIN_MAX_RESPONSE_TOKENS}
			max={MAX_MAX_RESPONSE_TOKENS}
			step="512"
			value={maxResponseTokens}
			onchange={(e) => onTokensChange('maxResponseTokens', e.currentTarget.value)}
		/>
	</label>
	<label
		class="tokens-row"
		title="Chat when it writes a file, the Code tab, and the Shell's Full access. The whole document must fit in one reply, and a reasoning model spends part of it thinking first. A reply cut off by either limit is refused, so a file is never left half-written. {MIN_MAX_RESPONSE_TOKENS}–{MAX_MAX_RESPONSE_TOKENS}."
	>
		<span class="tokens-label">
			Max response tokens (file writes)
			<span class="tokens-sub">The longest reply when the model writes a file.</span>
		</span>
		<input
			type="number"
			min={MIN_MAX_RESPONSE_TOKENS}
			max={MAX_MAX_RESPONSE_TOKENS}
			step="512"
			value={maxResponseTokensFileWrite}
			onchange={(e) => onTokensChange('maxResponseTokensFileWrite', e.currentTarget.value)}
		/>
	</label>
</section>

<style>
	.hint {
		margin: 0 0 16px 0;
	}

	/* Global .toggle-row supplies the base style; sections add row padding. */
	.toggle-row {
		padding: 8px 0;
	}

	.effort {
		margin: 4px 0 12px;
	}

	.effort label {
		display: block;
		font-size: 0.85rem;
		font-weight: 500;
		margin-bottom: 6px;
	}

	.effort select {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.9rem;
		background-color: var(--bg-primary);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	.effort .hint {
		margin-top: 6px;
	}

	.tokens-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-top: 12px;
	}

	.tokens-label {
		font-size: 0.85rem;
		color: var(--text-primary);
	}

	.tokens-sub {
		display: block;
		font-size: 0.7rem;
		color: var(--text-secondary);
		margin-top: 2px;
		max-width: 46ch;
	}

	.tokens-row input {
		flex-shrink: 0;
		width: 9ch;
		padding: 6px 8px;
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
		text-align: right;
		color: var(--text-primary);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
	}

	.tokens-row input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
