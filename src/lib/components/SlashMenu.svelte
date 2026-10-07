<script lang="ts">
	/**
	 * The `/` list for the Chat and Shell input boxes: built-in commands and
	 * skills, filtered as the name is typed. The parent hands every keydown to
	 * `handleKey` first, which takes the arrows, Enter, Tab and Escape while
	 * the list is open and leaves them alone otherwise.
	 *
	 * Opens above the input, which sits at the bottom of the window.
	 */
	import { matchItems, slashItems, typingName, type SlashItem } from '#lib/slash/slash.ts';

	let {
		text,
		projectRoot = async () => null,
		codeMode = false,
		onPick
	}: {
		/** The input box's current text. */
		text: string;
		/** The trusted repo whose project skills to list, found when the list opens. */
		projectRoot?: () => Promise<string | null>;
		/** Code mode is on, which lists the built-ins that need it. */
		codeMode?: boolean;
		/** Replace the input's text with the chosen `/name `. */
		onPick: (text: string) => void;
	} = $props();

	let items = $state<SlashItem[]>([]);
	let selected = $state(0);
	let dismissed = $state<string | null>(null);

	const typed = $derived(typingName(text));
	const matches = $derived(typed === null ? [] : matchItems(items, typed));
	const open = $derived(typed !== null && dismissed !== text && matches.length > 0);

	// Load when a `/` starts the text, so a skill added in Settings shows up
	// on the next `/` without a restart. One load per `/`, not per keystroke.
	let loadedFor = false;
	$effect(() => {
		if (typed === null) {
			loadedFor = false;
			return;
		}
		if (loadedFor) return;
		loadedFor = true;
		void projectRoot()
			.then((root) => slashItems(root, codeMode))
			.then((list) => (items = list));
	});

	$effect(() => {
		void typed;
		selected = 0;
	});

	function pick(item: SlashItem) {
		onPick(`/${item.name} `);
	}

	/** True when the key was the list's to handle. */
	export function handleKey(e: KeyboardEvent): boolean {
		if (!open) return false;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			const step = e.key === 'ArrowDown' ? 1 : -1;
			selected = (selected + step + matches.length) % matches.length;
		} else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
			pick(matches[selected]);
		} else if (e.key === 'Escape') {
			dismissed = text;
		} else {
			return false;
		}
		e.preventDefault();
		return true;
	}
</script>

{#if open}
	<ul class="slash-menu" role="listbox" aria-label="Commands and skills">
		{#each matches as item, i (item.name)}
			<li role="option" aria-selected={i === selected}>
				<button
					class:selected={i === selected}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => pick(item)}
				>
					<span class="name">/{item.name}</span>
					<span class="desc">{item.description}</span>
				</button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.slash-menu {
		position: absolute;
		bottom: calc(100% + 4px);
		left: 0;
		right: 0;
		z-index: 30;
		max-height: 240px;
		overflow-y: auto;
		margin: 0;
		padding: 4px;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-raised);
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
	}

	button {
		display: flex;
		gap: 10px;
		width: 100%;
		padding: 5px 8px;
		border: none;
		border-radius: 5px;
		background: none;
		color: var(--text-primary);
		text-align: left;
		cursor: pointer;
	}

	button.selected,
	button:hover {
		background: var(--accent-soft);
	}

	.name {
		font-family: monospace;
		white-space: nowrap;
	}

	.desc {
		overflow: hidden;
		color: var(--text-secondary);
		font-size: 0.85em;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
</style>
