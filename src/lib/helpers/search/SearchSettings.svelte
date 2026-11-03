<script lang="ts">
	/**
	 * The Search helper's row in Settings → Code → Helpers: an optional
	 * reranker (server, API key, model). Saved on every change; a URL with no
	 * model is kept but ranks nothing until a model is picked.
	 */
	import ApiKeyPicker from '#lib/components/settings/ApiKeyPicker.svelte';
	import { listServerModels, type ServerModel } from '#lib/rerank.ts';
	import { getSettings, setCodeHelperConfig } from '#lib/stores/settings.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { helperId }: { helperId: string } = $props();

	const stored = (getSettings().codeHelperConfig?.search as { rerank?: Record<string, unknown> })
		?.rerank;
	const text = (v: unknown) => (typeof v === 'string' ? v : '');
	let url = $state(text(stored?.url));
	let keyId = $state<string | null>(typeof stored?.keyId === 'string' ? stored.keyId : null);
	let model = $state(text(stored?.model));
	let listed = $state<ServerModel[]>([]);
	let fetchNote = $state('');

	/** Rerank models when the server reports capabilities; every model when it doesn't. */
	const choices = $derived.by(() => {
		const reported = listed.some((m) => m.capabilities !== null);
		const ids = listed
			.filter((m) => !reported || m.capabilities?.includes('rerank'))
			.map((m) => m.id);
		return model && !ids.includes(model) ? [model, ...ids] : ids;
	});

	function save() {
		const u = url.trim();
		setCodeHelperConfig(
			helperId,
			u || model ? { rerank: { url: u, keyId, model } } : { rerank: null }
		);
	}

	function clear() {
		url = '';
		keyId = null;
		model = '';
		listed = [];
		fetchNote = '';
		setCodeHelperConfig(helperId, { rerank: null });
	}

	async function fetchModels() {
		fetchNote = '';
		try {
			listed = await listServerModels(url.trim(), keyId);
			if (choices.length === 0) fetchNote = 'The server lists no rerank models.';
			else if (!model) {
				model = choices[0];
				save();
			}
		} catch (e) {
			fetchNote = `Couldn't list models: ${errMessage(e)}`;
		}
	}
</script>

<div class="search-settings">
	<p
		class="help"
		title="Any server with /v1/rerank: llama-toolchest, or llama-server started with --reranking."
	>
		Optional: rerank results with a server you run.
	</p>
	<div class="form">
		<label for="search-rerank-url">Reranker</label>
		<input
			id="search-rerank-url"
			bind:value={url}
			onchange={save}
			placeholder="http://localhost:8080"
		/>

		<span class="label">API key</span>
		<ApiKeyPicker
			selectedId={keyId}
			onSelect={(id) => {
				keyId = id;
				save();
			}}
		/>

		<label for="search-rerank-model">Model</label>
		<div>
			<div class="inline">
				<select id="search-rerank-model" bind:value={model} onchange={save}>
					<option value="">None</option>
					{#each choices as m (m)}<option value={m}>{m}</option>{/each}
				</select>
				<button type="button" class="btn btn-small" onclick={fetchModels} disabled={!url.trim()}
					>Fetch</button
				>
				<button type="button" class="btn btn-small" onclick={clear}>Clear</button>
			</div>
			{#if fetchNote}<p class="help">{fetchNote}</p>{/if}
		</div>
	</div>
</div>

<style>
	.search-settings {
		margin: 4px 0 10px;
	}

	.form {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 8px 12px;
		align-items: start;
		font-size: 0.85rem;
	}

	.form > label,
	.label {
		padding-top: 6px;
		color: var(--text-secondary);
	}

	input,
	select {
		width: 100%;
		box-sizing: border-box;
		padding: 5px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
	}

	.inline {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.inline select {
		flex: 1;
	}

	.help {
		margin: 0 0 6px;
		color: var(--text-secondary);
		font-size: 0.8rem;
	}
</style>
