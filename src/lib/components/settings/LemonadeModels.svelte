<script lang="ts">
	import { errMessage } from '#lib/utils/error.ts';
	import { formatGigabytes } from '#lib/utils/format.ts';
	import Tooltip from '#lib/components/Tooltip.svelte';
	import DownloadProgressBar from '#lib/components/settings/DownloadProgressBar.svelte';
	import { lemonadeCatalogue, serverState } from '#lib/image/lemonade/backend.ts';
	import { bareName } from '#lib/image/lemonade/adapter.ts';
	import {
		UPSCALER_INSTALL,
		cancelInstall,
		getInstall,
		installModel,
		installUpscaler,
		removeModel,
		resumeInstall
	} from '#lib/image/lemonade/install.svelte.ts';
	import type { LemonadeModel } from '#lib/ipc/gen/LemonadeModel.ts';

	// The same shape as ComfyModels: the parent probes, this lists what the
	// server has and installs the rest, and the Model dropdown chooses.
	interface Props {
		/** Bumped by the parent after each probe, so the rows re-check. */
		probeCount: number;
		/** Ask the parent to probe again: a new model shows up in its list. */
		onInstalled: () => void;
	}
	let { probeCount, onInstalled }: Props = $props();

	let models = $state<LemonadeModel[]>([]);
	let downloaded = $state<Set<string>>(new Set());
	/** Installed models with vision weights, which edit. */
	let edits = $state<Set<string>>(new Set());
	let upscaler = $state(false);
	/** Lists vision weights, so an install without them can add them. */
	const editable = (m: LemonadeModel) =>
		(m.pull as { checkpoints?: Record<string, string> })?.checkpoints?.llm_vision !== undefined;
	let error = $state('');
	const install = $derived(getInstall());

	const installed = (m: LemonadeModel) => downloaded.has(bareName(m.name));

	async function refresh() {
		try {
			models = await lemonadeCatalogue();
			const state = await serverState();
			downloaded = state.downloaded;
			edits = state.edits;
			upscaler = state.upscaler;
		} catch (e) {
			error = errMessage(e);
		}
	}

	$effect(() => {
		void probeCount;
		void refresh();
	});

	// An install that was running when Settings last closed.
	$effect(() => {
		void resumeInstall()
			.catch((e) => (error = errMessage(e)))
			.then(onInstalled);
	});

	async function installIt(m: LemonadeModel) {
		// Asked before anything downloads: the point is to stop gigabytes
		// arriving for a licence the user cannot use.
		if (!m.commercial_use) {
			const ok = window.confirm(
				`${m.license}\n\nThis model may not be used commercially. Install it anyway?`
			);
			if (!ok) return;
		}
		error = '';
		try {
			await installModel(m);
		} catch (e) {
			error = errMessage(e);
		} finally {
			onInstalled();
		}
	}

	async function installTheUpscaler() {
		error = '';
		try {
			await installUpscaler();
		} catch (e) {
			error = errMessage(e);
		} finally {
			onInstalled();
		}
	}

	async function remove(m: LemonadeModel) {
		error = '';
		try {
			await removeModel(m);
		} catch (e) {
			error = errMessage(e);
		} finally {
			onInstalled();
		}
	}
</script>

{#if models.length > 0}
	<section class="settings-section">
		<h2>
			Models on the server
			<Tooltip
				label="How models are installed"
				text="Lemonade downloads the files on the server and sets the model up there. The download carries on if you close Settings."
			/>
		</h2>
		{#each models as m (m.id)}
			<div class="model">
				<div class="model-head">
					<strong>{m.description}</strong>
					{#if installed(m)}<span class="badge">installed</span>{/if}
				</div>
				<p class="help" title={m.name}>
					{m.license}
					<a href={m.license_url} target="_blank" rel="noreferrer">Full text</a>
				</p>
				{#if !m.commercial_use}
					<p class="warn">Not licensed for commercial use.</p>
				{/if}
				{#if install?.id === m.id}
					<DownloadProgressBar progress={install.progress} oncancel={() => void cancelInstall()} />
				{:else}
					<div class="actions">
						{#if installed(m)}
							<button onclick={() => remove(m)} disabled={install !== null}>Remove</button>
							{#if editable(m) && !edits.has(bareName(m.name))}
								<button
									onclick={() => installIt(m)}
									disabled={install !== null}
									title="Downloads the vision weights it edits pictures with."
								>
									Add editing
								</button>
							{/if}
						{:else}
							<span class="help">Needs {formatGigabytes(m.size_bytes)}.</span>
							<button
								onclick={() => installIt(m)}
								disabled={install !== null}
								title={install ? 'Another model is installing.' : undefined}
							>
								Install
							</button>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
		<div class="model">
			<div class="model-head">
				<strong>Upscaler — Real-ESRGAN x4plus, for making pictures larger</strong>
				{#if upscaler}<span class="badge">installed</span>{/if}
			</div>
			<p class="help">BSD 3-Clause — commercial use allowed. Lemonade's own copy, 62 MB.</p>
			{#if install?.id === UPSCALER_INSTALL}
				<DownloadProgressBar progress={install.progress} oncancel={() => void cancelInstall()} />
			{:else if !upscaler}
				<div class="actions">
					<button
						onclick={installTheUpscaler}
						disabled={install !== null}
						title={install ? 'Another model is installing.' : undefined}
					>
						Install
					</button>
				</div>
			{/if}
		</div>
		{#if error}<p class="warn">{error}</p>{/if}
	</section>
{/if}

<style>
	.actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 6px;
	}
</style>
