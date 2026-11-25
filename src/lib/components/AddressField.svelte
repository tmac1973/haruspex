<script lang="ts">
	/**
	 * To or Cc in Review email: a text field of comma-separated addresses that
	 * suggests contacts as the last entry is typed. ↑ ↓ move, Enter or Tab
	 * picks, Esc closes the list (and not the dialog). A pick fills in
	 * `Name <address>, ` ready for the next one.
	 */
	import {
		completeField,
		matchContacts,
		typedEntry,
		type ContactAddress
	} from '#lib/email/contacts.ts';

	interface Props {
		label: string;
		value: string;
		contacts: readonly ContactAddress[];
		disabled?: boolean;
		input?: HTMLInputElement;
	}

	let {
		label,
		value = $bindable(),
		contacts,
		disabled = false,
		input = $bindable()
	}: Props = $props();

	const id = `address-${Math.random().toString(36).slice(2, 8)}`;
	let focused = $state(false);
	let closed = $state(false);
	let active = $state(0);

	const suggestions = $derived(
		focused && !closed ? matchContacts(contacts, typedEntry(value)) : []
	);
	const open = $derived(suggestions.length > 0);

	function pick(c: ContactAddress) {
		value = completeField(value, c);
		active = 0;
		input?.focus();
	}

	function onkeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const n = suggestions.length;
			active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
		} else if (e.key === 'Enter' || e.key === 'Tab') {
			e.preventDefault();
			pick(suggestions[Math.min(active, suggestions.length - 1)]);
		} else if (e.key === 'Escape') {
			// The list closes; the dialog stays.
			e.preventDefault();
			e.stopPropagation();
			closed = true;
		}
	}

	function oninput() {
		closed = false;
		active = 0;
	}
</script>

<div class="field">
	<label for={id}>{label}</label>
	<div class="wrap">
		<input
			{id}
			type="text"
			bind:this={input}
			bind:value
			{disabled}
			role="combobox"
			aria-autocomplete="list"
			aria-expanded={open}
			aria-controls="{id}-list"
			aria-activedescendant={open ? `${id}-opt-${active}` : undefined}
			autocomplete="off"
			{onkeydown}
			{oninput}
			onfocus={() => (focused = true)}
			onblur={() => (focused = false)}
		/>
		{#if open}
			<ul class="list" id="{id}-list" role="listbox" aria-label="{label} suggestions">
				{#each suggestions as c, i (c.email)}
					<li
						id="{id}-opt-{i}"
						role="option"
						aria-selected={i === active}
						class:active={i === active}
						onmousedown={(e) => {
							e.preventDefault();
							pick(c);
						}}
					>
						<span class="name">{c.name || c.email}</span>
						{#if c.name}<span class="email">{c.email}</span>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

<style>
	.field {
		display: grid;
		grid-template-columns: 4.5rem 1fr;
		align-items: center;
		gap: 0.5rem;
	}

	label {
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.wrap {
		position: relative;
	}

	input {
		width: 100%;
		box-sizing: border-box;
	}

	.list {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 10;
		margin: 2px 0 0;
		padding: 4px 0;
		list-style: none;
		max-height: 16rem;
		overflow-y: auto;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 6px;
		box-shadow: 0 4px 12px rgb(0 0 0 / 0.2);
	}

	li {
		display: flex;
		gap: 0.6rem;
		align-items: baseline;
		padding: 4px 10px;
		cursor: pointer;
	}

	li.active,
	li:hover {
		background: var(--bg-secondary);
	}

	.email {
		color: var(--text-secondary);
		font-size: 0.85rem;
	}
</style>
