<script lang="ts" module>
	/** The page widths the toolbar offers, in CSS pixels; `null` fills the window. */
	export const PREVIEW_WIDTHS = [
		{ id: 'phone', label: 'Phone', px: 390, tip: 'Show the page 390 pixels wide, like a phone.' },
		{
			id: 'tablet',
			label: 'Tablet',
			px: 820,
			tip: 'Show the page 820 pixels wide, like a tablet.'
		},
		{ id: 'full', label: 'Full', px: null, tip: 'Show the page as wide as the window.' }
	] as const;

	export type PreviewWidth = (typeof PREVIEW_WIDTHS)[number]['id'];
</script>

<script lang="ts">
	/** A preview window's toolbar: the file, Reload, the widths, and the browser. */
	let {
		path,
		url,
		width,
		onReload,
		onWidth,
		onOpenInBrowser
	}: {
		path: string;
		url: string;
		width: PreviewWidth;
		onReload: () => void;
		onWidth: (w: PreviewWidth) => void;
		onOpenInBrowser: () => void;
	} = $props();
</script>

<div class="toolbar">
	<span class="path" title={url}>{path}</span>
	<button
		title="Load the page again. It also reloads by itself when its files change."
		onclick={onReload}>Reload</button
	>
	<div class="widths" role="group" aria-label="Page width">
		{#each PREVIEW_WIDTHS as w (w.id)}
			<button
				class:active={w.id === width}
				aria-pressed={w.id === width}
				title={w.tip}
				onclick={() => onWidth(w.id)}>{w.label}</button
			>
		{/each}
	</div>
	<button
		title="Open this address in your web browser. It works while this window is open."
		onclick={onOpenInBrowser}>Open in browser</button
	>
</div>

<style>
	.toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
		font-size: 0.8rem;
		flex: 0 0 auto;
	}
	.path {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-secondary);
		font-family: var(--font-mono, monospace);
	}
	.widths {
		display: flex;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}
	button {
		appearance: none;
		background: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text-primary);
		padding: 3px 10px;
		font: inherit;
		cursor: pointer;
	}
	.widths button {
		border: 0;
		border-radius: 0;
	}
	.widths button + button {
		border-left: 1px solid var(--border);
	}
	button:hover {
		background: var(--bg-primary);
	}
	button.active {
		background: var(--accent);
		color: var(--accent-contrast);
	}
</style>
