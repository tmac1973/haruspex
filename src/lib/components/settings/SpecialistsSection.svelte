<script lang="ts">
	/**
	 * Settings → Code → Specialists: small models the Code tab's model can hand
	 * a narrow job to (`ask_specialist`). The list is driven by the registered
	 * kinds; one row's editor is open at a time, and saves only on its Save.
	 */
	import SpecialistEntryEditor from '#lib/components/settings/SpecialistEntryEditor.svelte';
	import { newSpecialistEntry, specialistBaseUrl } from '#lib/specialists/entries.ts';
	import { specialistKind, specialistKinds } from '#lib/specialists/kinds.ts';
	import '#lib/specialists/kinds/index.ts';
	import type { SpecialistEntry } from '#lib/specialists/types.ts';
	import { getSettings, setSpecialistEntries } from '#lib/stores/settings.ts';

	/** The list as saved, read again after every change. */
	let entries = $state<SpecialistEntry[]>(getSettings().specialists);
	let openId = $state<string | null>(null);
	/** An entry added but not yet saved: dropped if its editor is cancelled. */
	let pending = $state<SpecialistEntry | null>(null);

	const kinds = specialistKinds();
	const shown = $derived(pending ? [...entries, pending] : entries);

	function save(list: SpecialistEntry[]) {
		setSpecialistEntries($state.snapshot(list) as SpecialistEntry[]);
		entries = getSettings().specialists;
	}

	function where(e: SpecialistEntry): string {
		const label = specialistKind(e.kind)?.label ?? `Unknown kind (${e.kind})`;
		const host = e.url.trim() ? specialistBaseUrl(e.url).replace(/^https?:\/\//, '') : 'no server';
		return `${label} · ${e.model || 'no model'} on ${host}`;
	}

	function add(e: Event) {
		const select = e.currentTarget as HTMLSelectElement;
		const kindId = select.value;
		select.value = '';
		if (!kindId) return;
		pending = newSpecialistEntry(kindId, entries);
		openId = pending.id;
	}

	function toggle(id: string) {
		if (pending && openId === pending.id) pending = null;
		openId = openId === id ? null : id;
	}

	function commit(next: SpecialistEntry) {
		const exists = entries.some((e) => e.id === next.id);
		save(exists ? entries.map((e) => (e.id === next.id ? next : e)) : [...entries, next]);
		pending = null;
		openId = null;
	}

	function cancel() {
		pending = null;
		openId = null;
	}

	function setOnByDefault(e: SpecialistEntry, on: boolean) {
		save(entries.map((o) => (o.id === e.id ? { ...o, onByDefault: on } : o)));
	}

	function remove(e: SpecialistEntry) {
		save(entries.filter((o) => o.id !== e.id));
		if (openId === e.id) openId = null;
	}
</script>

<section class="settings-section">
	<h2>Specialists</h2>
	<p
		class="help"
		title="The agent calls one with ask_specialist when a Code session has it on (the Specialists menu in the session's header). You run the model's server; Haruspex never downloads or starts it."
	>
		Small models the Code tab's agent can hand a narrow job to.
	</p>
	{#if shown.length === 0}
		<p class="help">None yet.</p>
	{/if}

	<ul class="entries">
		{#each shown as e (e.id)}
			<li class="entry" class:open={openId === e.id}>
				<div class="entry-head">
					<button class="entry-name" aria-expanded={openId === e.id} onclick={() => toggle(e.id)}>
						<strong>{e.name}</strong>
						<span class="where">{where(e)}</span>
					</button>
					{#if e !== pending}
						<label
							class="check"
							title="New Code sessions offer it until you change the session's Specialists menu."
						>
							<input
								type="checkbox"
								checked={e.onByDefault}
								onchange={(ev) => setOnByDefault(e, ev.currentTarget.checked)}
							/>
							<span>On by default</span>
						</label>
						<button class="btn btn-small" aria-label={`Remove ${e.name}`} onclick={() => remove(e)}
							>Remove</button
						>
					{/if}
				</div>
				{#if openId === e.id && specialistKind(e.kind)}
					<div class="editor">
						{#key e.id}
							<SpecialistEntryEditor
								entry={e}
								otherNames={entries.filter((o) => o.id !== e.id).map((o) => o.name)}
								onSave={commit}
								onCancel={cancel}
							/>
						{/key}
					</div>
				{/if}
			</li>
		{/each}
	</ul>

	<div class="actions">
		<select aria-label="Add a specialist" onchange={add} value="">
			<option value="">Add specialist…</option>
			{#each kinds as k (k.id)}
				<option value={k.id} title={k.summary}>{k.label}</option>
			{/each}
		</select>
	</div>
</section>

<style>
	.help {
		color: var(--text-secondary);
		font-size: 0.85rem;
		line-height: 1.45;
		margin: 8px 0 0;
	}

	.entries {
		list-style: none;
		padding: 0;
		margin: 8px 0 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.entry {
		border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
		border-radius: 6px;
		padding: 8px 10px;
	}

	.entry-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.entry-name {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 8px;
		text-align: left;
		background: none;
		border: none;
		padding: 2px 0;
		cursor: pointer;
		color: inherit;
		font: inherit;
	}

	.entry-name strong {
		white-space: nowrap;
	}

	.where {
		font-size: 0.85em;
		color: var(--text-muted, #888);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.check {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 0.8rem;
		white-space: nowrap;
	}

	.editor {
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--border, rgba(127, 127, 127, 0.2));
	}

	.actions {
		margin-top: 8px;
	}

	.actions select {
		padding: 5px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 0.85rem;
	}
</style>
