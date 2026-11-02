<script lang="ts">
	/**
	 * One specialist's form in Settings → Code → Specialists. Edits a draft;
	 * nothing is saved until Save. Every field is generic: the kind only
	 * supplies the defaults shown as placeholders.
	 */
	import ApiKeyPicker from '#lib/components/settings/ApiKeyPicker.svelte';
	import { callSpecialist, listSpecialistModels } from '#lib/specialists/call.ts';
	import { specialistKind } from '#lib/specialists/kinds.ts';
	import type { SpecialistEntry, SpecialistSampling } from '#lib/specialists/types.ts';
	import { errMessage } from '#lib/utils/error.ts';

	interface Props {
		entry: SpecialistEntry;
		/** Every other entry's name, for the duplicate check. */
		otherNames: string[];
		onSave: (entry: SpecialistEntry) => void;
		onCancel: () => void;
	}

	let { entry, otherNames, onSave, onCancel }: Props = $props();

	const kind = $derived(specialistKind(entry.kind));
	const defaults = $derived(kind?.defaultSampling ?? { max_tokens: 4096 });

	/** The sampling fields the form edits; empty leaves the kind's default. */
	type NumberField = 'temperature' | 'top_p' | 'top_k' | 'min_p' | 'max_tokens';
	const NUMBER_FIELDS: { key: NumberField; label: string; step: string }[] = [
		{ key: 'temperature', label: 'Temperature', step: '0.05' },
		{ key: 'top_p', label: 'Top-p', step: '0.01' },
		{ key: 'top_k', label: 'Top-k', step: '1' },
		{ key: 'min_p', label: 'Min-p', step: '0.01' },
		{ key: 'max_tokens', label: 'Max tokens', step: '256' }
	];

	// The form starts from the entry it was opened with; the parent remounts it per entry.
	// svelte-ignore state_referenced_locally
	const start = entry;
	const startKind = specialistKind(start.kind);
	let name = $state(start.name);
	let url = $state(start.url);
	let keyId = $state<string | null>(start.keyId);
	let model = $state(start.model);
	let description = $state(start.description ?? '');
	let noSystemPrompt = $state(start.systemPrompt === '');
	let systemPrompt = $state(start.systemPrompt || (startKind?.defaultSystemPrompt ?? ''));
	// A number input binds a number, or null when cleared.
	let numbers = $state<Record<NumberField, number | null>>(
		Object.fromEntries(
			NUMBER_FIELDS.map((f) => [f.key, start.sampling?.[f.key] ?? null])
		) as Record<NumberField, number | null>
	);
	let thinking = $state<'kind' | 'on' | 'off'>(
		start.sampling?.thinking === undefined ? 'kind' : start.sampling.thinking ? 'on' : 'off'
	);
	let acceptsImages = $state(start.acceptsImages);

	let models = $state<string[]>([]);
	let fetchNote = $state('');
	let testNote = $state('');
	let testing = $state(false);

	const nameError = $derived.by(() => {
		const n = name.trim();
		if (!n) return 'Give it a name.';
		const lower = n.toLowerCase();
		return otherNames.some((o) => o.toLowerCase() === lower)
			? 'Another specialist has this name.'
			: '';
	});

	function thinkingLabel(): string {
		const t = defaults.thinking;
		return `Kind default (${t === undefined ? 'server' : t ? 'on' : 'off'})`;
	}

	/** The form as an entry, as Save would store it. */
	function draft(): SpecialistEntry {
		const sampling: Partial<SpecialistSampling> = {};
		for (const f of NUMBER_FIELDS) {
			const v = numbers[f.key];
			if (typeof v === 'number' && Number.isFinite(v)) sampling[f.key] = v;
		}
		if (thinking !== 'kind') sampling.thinking = thinking === 'on';
		const prompt = systemPrompt.trim();
		return {
			...entry,
			name: name.trim(),
			url: url.trim(),
			keyId,
			model: model.trim(),
			description: description.trim() || null,
			// Empty or the kind's own text: follow the kind, so a change to its default reaches it.
			systemPrompt: noSystemPrompt
				? ''
				: !prompt || systemPrompt === kind?.defaultSystemPrompt
					? null
					: systemPrompt,
			sampling: Object.keys(sampling).length ? sampling : null,
			acceptsImages
		};
	}

	function resetPrompt() {
		noSystemPrompt = false;
		systemPrompt = kind?.defaultSystemPrompt ?? '';
	}

	async function fetchModels() {
		fetchNote = '';
		try {
			models = await listSpecialistModels(draft());
			fetchNote = models.length ? `${models.length} models` : 'The server lists no models.';
		} catch (e) {
			fetchNote = `Couldn't list models: ${errMessage(e)}`;
		}
	}

	async function test() {
		testing = true;
		testNote = '';
		try {
			const answer = await callSpecialist(draft(), 'Reply with OK.', { maxTokens: 64 });
			const line = answer.content.trim().split('\n')[0];
			testNote = line
				? `Answered: ${line.slice(0, 120)}`
				: 'It answered with no text. If it only thought, set Thinking to Off.';
		} catch (e) {
			testNote = `Failed: ${errMessage(e)}`;
		} finally {
			testing = false;
		}
	}
</script>

<div class="form">
	<label for="sp-name-{entry.id}">Name</label>
	<div>
		<input id="sp-name-{entry.id}" bind:value={name} title="What the agent calls it." />
		{#if nameError}<p class="error">{nameError}</p>{/if}
	</div>

	<label for="sp-url-{entry.id}">Server</label>
	<input
		id="sp-url-{entry.id}"
		bind:value={url}
		placeholder="http://localhost:8080"
		title="An OpenAI-compatible server: llama-server, llama-toolchest, Lemonade or any other."
	/>

	<span class="label">API key</span>
	<ApiKeyPicker selectedId={keyId} onSelect={(id) => (keyId = id)} />

	<label for="sp-model-{entry.id}">Model</label>
	<div>
		<div class="inline">
			<input id="sp-model-{entry.id}" bind:value={model} list="sp-models-{entry.id}" />
			<button type="button" class="btn btn-small" onclick={fetchModels} disabled={!url.trim()}
				>Fetch</button
			>
		</div>
		<datalist id="sp-models-{entry.id}">
			{#each models as m (m)}<option value={m}></option>{/each}
		</datalist>
		{#if fetchNote}<p class="help">{fetchNote}</p>{/if}
	</div>

	<label for="sp-desc-{entry.id}">Description</label>
	<textarea
		id="sp-desc-{entry.id}"
		rows="2"
		bind:value={description}
		placeholder={kind?.defaultDescription}
		title="Tells the agent when to use it. Empty uses the kind's own."></textarea>

	<label for="sp-prompt-{entry.id}">System prompt</label>
	<div>
		<textarea
			id="sp-prompt-{entry.id}"
			rows="4"
			bind:value={systemPrompt}
			disabled={noSystemPrompt}
			title="Sent before every request. Empty uses the kind's own."></textarea>
		<div class="inline">
			<label class="check" title="For servers that set the prompt themselves.">
				<input type="checkbox" bind:checked={noSystemPrompt} />
				<span>Send no system prompt</span>
			</label>
			<button type="button" class="btn btn-small" onclick={resetPrompt}>Reset</button>
		</div>
	</div>

	<span class="label">Sampling</span>
	<div class="numbers">
		{#each NUMBER_FIELDS as f (f.key)}
			<label class="number">
				<span>{f.label}</span>
				<input
					type="number"
					step={f.step}
					bind:value={numbers[f.key]}
					placeholder={defaults[f.key] === undefined ? 'server' : String(defaults[f.key])}
				/>
			</label>
		{/each}
		<label class="number">
			<span>Thinking</span>
			<select
				bind:value={thinking}
				title="Some small models think until they run out of tokens. Turn it off if answers come back empty."
			>
				<option value="kind">{thinkingLabel()}</option>
				<option value="on">On</option>
				<option value="off">Off</option>
			</select>
		</label>
	</div>

	<span class="label">Images</span>
	<label class="check" title="Turn on when the server has this model's vision projector loaded.">
		<input type="checkbox" bind:checked={acceptsImages} />
		<span>Accepts images</span>
	</label>
</div>

<div class="actions">
	<button
		type="button"
		class="btn btn-small"
		onclick={test}
		disabled={testing || !url.trim() || !model.trim()}
	>
		{testing ? 'Testing…' : 'Test'}
	</button>
	{#if testNote}<span class="help">{testNote}</span>{/if}
	<span class="spacer"></span>
	<button type="button" class="btn btn-small" onclick={onCancel}>Cancel</button>
	<button
		type="button"
		class="btn btn-primary btn-small"
		disabled={!!nameError}
		onclick={() => onSave(draft())}>Save</button
	>
</div>

<style>
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

	input:not([type='checkbox']),
	textarea,
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

	textarea {
		resize: vertical;
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 0.8rem;
	}

	.inline {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 4px;
	}

	.inline input {
		flex: 1;
	}

	.check {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding-top: 4px;
	}

	.numbers {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
		gap: 6px 10px;
	}

	.number {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.help {
		margin: 4px 0 0;
		color: var(--text-secondary);
		font-size: 0.8rem;
	}

	.error {
		margin: 4px 0 0;
		color: var(--error-text);
		font-size: 0.8rem;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
	}

	.spacer {
		flex: 1;
	}
</style>
