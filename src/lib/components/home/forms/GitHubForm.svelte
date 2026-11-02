<script lang="ts">
	/** Add card → GitHub: what to watch for, where, and how to filter it. */
	import Modal from '#lib/components/Modal.svelte';
	import {
		GITHUB_PRESETS,
		badOwner,
		badRepo,
		splitList,
		type GitHubConfig,
		type GitHubPreset
	} from '#lib/home/github.ts';
	import type { CardFormProps } from '#lib/home/cardTypes.ts';

	let { open, defaultSchedule, onadd, ondone }: CardFormProps = $props();

	let preset = $state<GitHubPreset>('issues_from_others');
	let owners = $state('');
	let repos = $state('');
	let unanswered = $state(true);
	let excludeBots = $state(true);
	let labelsInclude = $state('');
	let labelsExclude = $state('');
	let days = $state(30);
	let max = $state(15);
	let saving = $state(false);
	let error = $state<string | null>(null);

	const ownerError = $derived(badOwner(splitList(owners)));
	const repoError = $derived(badRepo(splitList(repos)));
	const valid = $derived(
		!ownerError && !repoError && days >= 1 && days <= 365 && max >= 1 && max <= 50
	);
	const reviews = $derived(preset === 'prs_to_review');

	async function add() {
		if (!valid || saving) return;
		saving = true;
		error = null;
		const config: GitHubConfig = {
			preset,
			owners: splitList(owners),
			repos: splitList(repos),
			unanswered,
			excludeBots,
			labelsInclude: splitList(labelsInclude),
			labelsExclude: splitList(labelsExclude),
			days,
			max
		};
		try {
			if (await onadd({ ...config }, defaultSchedule)) ondone();
			else error = 'The card could not be added.';
		} finally {
			saving = false;
		}
	}
</script>

<Modal {open} title="GitHub" dismissable onclose={ondone} maxWidth={460}>
	<div class="form">
		<fieldset class="field">
			<legend class="label">Show</legend>
			{#each Object.entries(GITHUB_PRESETS) as [id, name] (id)}
				<label class="check">
					<input type="radio" name="github-preset" value={id} bind:group={preset} />
					{name}
				</label>
			{/each}
		</fieldset>
		<label class="field">
			<span class="label">Owners</span>
			<input
				placeholder="tmac1973, my-org"
				title="Users or organisations whose repos to watch. Both fields empty means your own repos."
				bind:value={owners}
			/>
			{#if ownerError}<span class="error">Not an owner: {ownerError}</span>{/if}
		</label>
		<label class="field">
			<span class="label">Repos</span>
			<input placeholder="owner/name, …" bind:value={repos} />
			{#if repoError}<span class="error">Not owner/name: {repoError}</span>{/if}
		</label>
		{#if !reviews}
			<label class="check">
				<input type="checkbox" bind:checked={unanswered} />
				Only ones you haven't commented on
			</label>
			<label class="check">
				<input type="checkbox" bind:checked={excludeBots} />
				Hide bots
			</label>
		{/if}
		<label class="field">
			<span class="label">Only with labels</span>
			<input placeholder="bug, help wanted" bind:value={labelsInclude} />
		</label>
		<label class="field">
			<span class="label">Hide labels</span>
			<input placeholder="wontfix" bind:value={labelsExclude} />
		</label>
		<div class="row">
			<label class="field">
				<span class="label">Updated in the last (days)</span>
				<input type="number" min="1" max="365" bind:value={days} />
			</label>
			<label class="field">
				<span class="label">Show at most</span>
				<input type="number" min="1" max="50" bind:value={max} />
			</label>
		</div>
		{#if error}
			<p class="error">{error}</p>
		{/if}
		<div class="buttons">
			<button type="button" class="btn" onclick={ondone}>Cancel</button>
			<button
				type="button"
				class="btn btn-primary"
				onclick={() => void add()}
				disabled={!valid || saving}>Add card</button
			>
		</div>
	</div>
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	fieldset {
		border: none;
		margin: 0;
		padding: 0;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.row {
		display: flex;
		gap: 12px;
	}

	.label {
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.88rem;
	}

	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	.error {
		margin: 0;
		font-size: 0.8rem;
		color: var(--error-text);
	}
</style>
