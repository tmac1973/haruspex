<script lang="ts">
	/**
	 * Mounted once in the root layout: draws the row menu that `rowMenu`
	 * opens (see `stores/rowMenu.svelte.ts`). Focus moves into the menu, the
	 * arrow keys walk it, and Escape, Tab, a click outside, a scroll or a
	 * resize closes it.
	 */
	import { tick } from 'svelte';
	import { closeRowMenu, getRowMenu, type RowMenuItem } from '#lib/stores/rowMenu.svelte.ts';

	const menu = $derived(getRowMenu());
	let el = $state<HTMLDivElement | null>(null);
	/** Where the menu sits once kept inside the window. */
	let pos = $state({ x: 0, y: 0 });

	$effect(() => {
		const m = menu;
		if (!m) return;
		pos = { x: m.x, y: m.y };
		void tick().then(() => {
			if (!el || getRowMenu() !== m) return;
			const r = el.getBoundingClientRect();
			pos = {
				x: Math.max(4, Math.min(m.x, window.innerWidth - r.width - 4)),
				y: Math.max(4, Math.min(m.y, window.innerHeight - r.height - 4))
			};
			buttons()[0]?.focus();
		});
	});

	function buttons(): HTMLButtonElement[] {
		return el ? [...el.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')] : [];
	}

	function dismiss(refocus: boolean): void {
		const back = menu?.returnFocus;
		closeRowMenu();
		if (refocus && back?.isConnected) back.focus();
	}

	function pick(item: RowMenuItem): void {
		closeRowMenu();
		item.run();
	}

	function onKeydown(e: KeyboardEvent): void {
		if (!menu) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			dismiss(true);
		} else if (e.key === 'Tab') {
			dismiss(false);
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const list = buttons();
			if (list.length === 0) return;
			const at = list.indexOf(document.activeElement as HTMLButtonElement);
			const step = e.key === 'ArrowDown' ? 1 : -1;
			list[(at + step + list.length) % list.length].focus();
		}
	}

	function onPointerdown(e: PointerEvent): void {
		if (menu && !el?.contains(e.target as Node)) dismiss(false);
	}
</script>

<svelte:window
	onkeydowncapture={onKeydown}
	onpointerdowncapture={onPointerdown}
	onresize={() => menu && dismiss(false)}
	onblur={() => menu && dismiss(false)}
/>
<svelte:document onscrollcapture={() => menu && dismiss(false)} />

{#if menu}
	<div
		class="row-menu"
		role="menu"
		tabindex="-1"
		bind:this={el}
		style="left: {pos.x}px; top: {pos.y}px"
		oncontextmenu={(e) => e.preventDefault()}
	>
		{#each menu.items as item (item.label)}
			<button
				role="menuitem"
				class:danger={item.danger}
				disabled={item.disabled}
				title={item.title}
				onclick={() => pick(item)}
			>
				{item.label}
			</button>
		{/each}
	</div>
{/if}

<style>
	.row-menu {
		position: fixed;
		z-index: 1000;
		display: flex;
		flex-direction: column;
		min-width: 140px;
		padding: 4px;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 6px;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
	}

	.row-menu button {
		appearance: none;
		background: none;
		border: 0;
		border-radius: 4px;
		padding: 6px 10px;
		text-align: left;
		font-size: 0.8rem;
		color: var(--text-primary);
		cursor: pointer;
	}

	.row-menu button:hover:not(:disabled),
	.row-menu button:focus-visible {
		background: var(--bg-secondary);
		outline: none;
	}

	.row-menu button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.row-menu button.danger {
		color: var(--error-text);
	}
</style>
