<script lang="ts">
	/**
	 * A right-click on text selected in an answer (Chat, Shell or Code)
	 * offers "Add selection to notebook…" beside Copy. Anywhere else the
	 * usual menu shows.
	 */
	import { captureText } from '#lib/notebooks/capture.ts';
	import { getLiveSettings } from '#lib/stores/settings.ts';
	import { copyText } from '#lib/utils/copyText.ts';

	/** Where answers are drawn: Chat and Shell's messages, Code's steps. */
	const ANSWER = '.message.assistant .message-content, .code-steps .lead';

	let menu = $state<{ x: number; y: number; text: string } | null>(null);

	function selectionIn(target: EventTarget | null): string | null {
		const sel = window.getSelection();
		const text = sel?.toString().trim();
		if (!sel || !text || sel.rangeCount === 0) return null;
		const node = sel.getRangeAt(0).commonAncestorContainer;
		const el = node instanceof Element ? node : node.parentElement;
		if (!el?.closest(ANSWER)) return null;
		if (!(target instanceof Node) || !el.closest(ANSWER)?.contains(target)) return null;
		return text;
	}

	function oncontextmenu(e: MouseEvent) {
		const s = getLiveSettings();
		if (!s.notebooksTab || s.leanMode) return;
		const text = selectionIn(e.target);
		if (!text) return;
		e.preventDefault();
		menu = { x: e.clientX, y: e.clientY, text };
	}

	function close() {
		menu = null;
	}
</script>

<svelte:window
	{oncontextmenu}
	onkeydown={(e) => {
		if (menu && e.key === 'Escape') close();
	}}
/>

{#if menu}
	<div
		class="backdrop"
		role="presentation"
		onclick={close}
		oncontextmenu={(e) => {
			e.preventDefault();
			close();
		}}
	></div>
	<div
		class="context-menu"
		role="menu"
		style="left:{Math.min(menu.x, window.innerWidth - 230)}px;top:{Math.min(
			menu.y,
			window.innerHeight - 90
		)}px"
	>
		<button
			role="menuitem"
			onclick={() => {
				const m = menu;
				close();
				if (m) void captureText(m.text, { x: m.x, y: m.y });
			}}
		>
			Add selection to notebook…
		</button>
		<button
			role="menuitem"
			onclick={() => {
				const t = menu?.text ?? '';
				close();
				void copyText(t).catch(() => {});
			}}
		>
			Copy
		</button>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 190;
	}

	.context-menu {
		position: fixed;
		z-index: 191;
		display: flex;
		flex-direction: column;
		min-width: 210px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		box-shadow: 0 6px 24px rgb(0 0 0 / 25%);
		overflow: hidden;
	}

	.context-menu button {
		text-align: left;
		padding: 7px 12px;
		border: none;
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.85rem;
	}

	.context-menu button + button {
		border-top: 1px solid var(--border);
	}

	.context-menu button:hover {
		background: var(--bg-primary);
	}
</style>
