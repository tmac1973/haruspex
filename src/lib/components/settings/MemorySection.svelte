<script lang="ts">
	/**
	 * Settings → Memory. The global switch, the one-time model download, and
	 * (from Phase 05) the manager.
	 *
	 * The consent step is in-card rather than a modal: it is information the
	 * user needs in order to answer the question the toggle is asking, not an
	 * interruption after they have answered it.
	 */
	import { onMount } from 'svelte';
	import { getSettings } from '$lib/stores/settings';
	import { cancelAllExtraction } from '$lib/agent/memory/scheduler';
	import {
		disableMemory,
		downloadModel,
		enableMemory,
		getMemoryCount,
		getModelError,
		getModelStatus,
		refreshMemoryCount,
		refreshModelStatus
	} from '$lib/stores/memory.svelte';

	let memoryEnabled = $state(getSettings().memoryEnabled);
	let busy = $state(false);

	const status = $derived(getModelStatus());
	const error = $derived(getModelError());
	const count = $derived(getMemoryCount());

	onMount(() => {
		void refreshModelStatus().then(() => refreshMemoryCount());
	});

	async function toggle() {
		// The checkbox has already flipped optimistically; put it back if the
		// model never arrives, so the control never claims a state the
		// machinery cannot honour.
		busy = true;
		try {
			if (memoryEnabled) {
				const ok = await enableMemory();
				memoryEnabled = ok;
			} else {
				await disableMemory();
				// Belt and braces: the scheduler re-checks before every pass, so a
				// timer armed while memory was on already no-ops. Dropping the
				// timers now just stops it holding them for the rest of the session.
				cancelAllExtraction();
			}
		} finally {
			busy = false;
		}
	}

	async function download() {
		busy = true;
		try {
			await downloadModel();
		} finally {
			busy = false;
		}
	}
</script>

<section class="settings-section">
	<h2>Remember across chats</h2>
	<label class="toggle-row">
		<input
			type="checkbox"
			bind:checked={memoryEnabled}
			onchange={toggle}
			disabled={busy || status === 'downloading'}
		/>
		<span>Carry facts and preferences from one conversation into the next</span>
	</label>
	<p class="help">
		Off by default. When on, Haruspex reads your finished conversations in the background, distils
		the stable facts — preferences, corrections, standing project context — and brings the relevant
		ones into later chats. Everything stays on this device: the text never leaves it, and the
		embeddings are computed here.
	</p>
	<p class="help">
		You can exclude any single chat with its incognito switch, and review, edit or delete everything
		that has been remembered below.
	</p>

	{#if status === 'ready'}
		<p class="help status-line">
			{count === 0
				? 'Nothing remembered yet.'
				: `${count} ${count === 1 ? 'memory' : 'memories'} stored.`}
		</p>
	{/if}
</section>

{#if status !== 'ready'}
	<section class="settings-section">
		<h2>Embedding model</h2>
		<p class="help">
			Memory needs a small embedding model (~65 MB, BGE-small-en-v1.5, quantized) to tell which
			remembered facts are relevant to what you are asking. It is downloaded once from Hugging Face
			and then runs entirely on this machine. Nothing is downloaded until you press the button.
		</p>

		{#if status === 'downloading'}
			<p class="help downloading">Downloading… this happens once.</p>
		{:else}
			<button type="button" class="btn" onclick={download} disabled={busy}>
				{status === 'error' ? 'Try the download again' : 'Download embedding model'}
			</button>
		{/if}

		{#if status === 'error' && error}
			<p class="help error-line">Download failed: {error}</p>
		{/if}

		{#if getSettings().memoryEnabled}
			<!-- Settings can arrive on a machine the weights never did. Say so
			     plainly rather than leaving a switch that reads "on" while
			     nothing is being remembered. -->
			<p class="help error-line">
				Memory is switched on but the model is missing on this machine, so nothing is being
				remembered or recalled. Download it to resume.
			</p>
		{/if}
	</section>
{/if}

<style>
	.status-line {
		margin-top: 4px;
	}

	.downloading {
		color: var(--accent);
	}

	.error-line {
		color: var(--error, #d66);
	}
</style>
