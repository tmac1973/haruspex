<script lang="ts">
	import { errMessage } from '#lib/utils/error.ts';
	import { formatGigabytes } from '#lib/utils/format.ts';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import { lemonadeApiKey } from '#lib/stores/imageSecrets.ts';
	import {
		savedSecretPlaceholder,
		secretStoreHint,
		secretStoreKind,
		type SecretStoreKind
	} from '#lib/stores/secrets.ts';
	import Tooltip from '#lib/components/Tooltip.svelte';
	import DownloadProgressBar from '#lib/components/settings/DownloadProgressBar.svelte';
	import { lemonadeBackend, lemonadeCatalogue, serverState } from '#lib/image/lemonade/backend.ts';
	import { bareName, type ServerState } from '#lib/image/lemonade/adapter.ts';
	import {
		cancelInstall,
		getInstall,
		installModel,
		removeModel,
		resumeInstall
	} from '#lib/image/lemonade/install.svelte.ts';
	import type { ProbeResult } from '#lib/image/backend.ts';
	import type { LemonadeModel } from '#lib/ipc/gen/LemonadeModel.ts';

	let baseUrl = $state(getSettings().imageLemonadeBaseUrl);
	let modelId = $state(getSettings().imageLemonadeModelId);
	let apiKeyDraft = $state('');
	let apiKeySaved = $state(lemonadeApiKey.configured());
	let storeKind = $state<SecretStoreKind>('keychain');
	void secretStoreKind().then((k) => (storeKind = k));

	let models = $state<LemonadeModel[]>([]);
	void lemonadeCatalogue()
		.then((m) => (models = m))
		.catch(() => {});

	let server = $state<ServerState | null>(null);
	let probing = $state(false);
	let probeResult = $state<ProbeResult | null>(null);
	let error = $state('');
	const install = $derived(getInstall());

	const installed = (m: LemonadeModel) => server?.downloaded.has(bareName(m.name)) ?? false;

	async function probe() {
		probing = true;
		error = '';
		try {
			server = await serverState().catch(() => null);
			probeResult = await lemonadeBackend.probe();
		} catch (e) {
			probeResult = { ok: false, detail: errMessage(e) };
		} finally {
			probing = false;
		}
	}

	// On opening: the server's state without a click, and an install that was
	// running when Settings last closed.
	let opened = false;
	$effect(() => {
		if (opened || !baseUrl.trim()) return;
		opened = true;
		void probe();
		void resumeInstall()
			.catch((e) => (error = errMessage(e)))
			.then(probe);
	});

	function saveUrl() {
		const next = baseUrl.trim();
		const changed = next !== getSettings().imageLemonadeBaseUrl;
		updateSettings({ imageLemonadeBaseUrl: next });
		if (changed && next) void probe();
	}

	async function saveApiKey() {
		const value = apiKeyDraft.trim();
		if (!value) return;
		try {
			await lemonadeApiKey.save(value);
			apiKeyDraft = '';
			apiKeySaved = true;
		} catch (e) {
			error = `Could not save the key: ${errMessage(e)}`;
		}
	}

	async function removeApiKey() {
		await lemonadeApiKey.remove();
		apiKeySaved = false;
	}

	function use(m: LemonadeModel) {
		modelId = m.id;
		updateSettings({ imageLemonadeModelId: m.id });
		void probe();
	}

	async function installIt(m: LemonadeModel) {
		// Asked before the download, as for the bundled engine.
		if (!m.commercial_use) {
			const ok = window.confirm(
				`${m.license}\n\nThis model may not be used commercially. Install it anyway?`
			);
			if (!ok) return;
		}
		error = '';
		try {
			await installModel(m);
			use(m);
		} catch (e) {
			error = errMessage(e);
		} finally {
			await probe();
		}
	}

	async function remove(m: LemonadeModel) {
		error = '';
		try {
			await removeModel(m);
			if (modelId === m.id) {
				modelId = '';
				updateSettings({ imageLemonadeModelId: '' });
			}
		} catch (e) {
			error = errMessage(e);
		} finally {
			await probe();
		}
	}
</script>

<section class="settings-section">
	<h2>Lemonade</h2>
	<div class="fields">
		<label for="lemonade-url">Server address:</label>
		<input
			id="lemonade-url"
			type="text"
			placeholder="http://127.0.0.1:13305"
			bind:value={baseUrl}
			onblur={saveUrl}
		/>

		<label for="lemonade-key">API key:</label>
		<input
			id="lemonade-key"
			type="password"
			placeholder={apiKeySaved ? savedSecretPlaceholder(storeKind) : 'only if the server needs one'}
			title={apiKeySaved ? secretStoreHint(storeKind) : undefined}
			bind:value={apiKeyDraft}
			onblur={saveApiKey}
		/>
		{#if apiKeySaved}
			<button type="button" onclick={removeApiKey}>Remove key</button>
		{/if}
	</div>

	<div class="actions">
		<button onclick={probe} disabled={probing}>{probing ? 'Probing…' : 'Probe'}</button>
		{#if probeResult}
			<span class="detail" class:bad={!probeResult.ok}>{probeResult.detail}</span>
		{/if}
	</div>
	<p class="help">
		Runs the bundled engine's models on a Lemonade server.
		<Tooltip
			label="About Lemonade"
			text="Install puts the model on the server and sets it up there; the files download on the server, not here. Lemonade keeps one image model loaded, so the first picture after a switch waits for it to load."
		/>
	</p>
</section>

{#if server}
	<section class="settings-section">
		<h2>Models on the server</h2>
		{#each models as m (m.id)}
			<div class="model" class:selected={modelId === m.id}>
				<div class="model-head">
					<strong>{m.description}</strong>
					{#if modelId === m.id}<span class="badge">selected</span>{/if}
				</div>
				<p class="help" title={m.name}>
					{m.license}
					<a href={m.license_url} target="_blank" rel="noreferrer">Full text</a>
					· {formatGigabytes(m.size_bytes)}
				</p>
				{#if !m.commercial_use}
					<p class="warn">Not licensed for commercial use.</p>
				{/if}
				<div class="row">
					{#if installed(m)}
						<button onclick={() => use(m)} disabled={modelId === m.id}>Use</button>
						<button onclick={() => remove(m)} disabled={install !== null}>Remove</button>
					{:else if install?.id !== m.id}
						<button
							onclick={() => installIt(m)}
							disabled={install !== null}
							title={install ? 'Another model is installing.' : undefined}
						>
							Install
						</button>
					{/if}
				</div>
				{#if install?.id === m.id}
					<DownloadProgressBar progress={install.progress} oncancel={() => void cancelInstall()} />
				{/if}
			</div>
		{/each}
		{#if error}
			<p class="warn">{error}</p>
		{/if}
	</section>
{/if}

<style>
	.fields {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		align-items: center;
		gap: 8px 12px;
		margin-top: 8px;
	}

	.fields input {
		width: 100%;
		min-width: 0;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 6px;
	}

	.detail {
		font-size: 0.85em;
		color: var(--text-muted, #888);
	}

	.detail.bad {
		color: var(--error, #c33);
	}
</style>
