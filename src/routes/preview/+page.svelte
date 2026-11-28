<script lang="ts">
	/**
	 * A Code preview window (`#lib/preview/open.ts`): a toolbar over an iframe
	 * of a page from the session's folder, served by Rust on 127.0.0.1. The
	 * root layout treats it as detached, so it runs none of the app's
	 * bootstrap. The page is another origin, so it reaches neither this
	 * window nor IPC; `allow-same-origin` only lets it keep its own storage.
	 */
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
	import PreviewToolbar, {
		PREVIEW_WIDTHS,
		type PreviewWidth
	} from '#lib/components/preview/PreviewToolbar.svelte';
	import {
		PREVIEW_CHANGED_EVENT,
		PREVIEW_NAVIGATE_EVENT,
		previewTitle,
		reloadUrl,
		type PreviewNavigate
	} from '#lib/preview/open.ts';
	import { openInBrowser } from '#lib/utils/openInBrowser.ts';
	import { followSettingsStorage } from '#lib/stores/settings.ts';

	const WIDTH_KEY = 'haruspex.previewWidth';
	const win = getCurrentWebviewWindow();

	let url = $state(page.url.searchParams.get('url') ?? '');
	let path = $state(page.url.searchParams.get('path') ?? '');
	let reloads = $state(0);
	let width = $state<PreviewWidth>(storedWidth());
	const src = $derived(reloads === 0 ? url : reloadUrl(url, reloads));
	const px = $derived(PREVIEW_WIDTHS.find((w) => w.id === width)?.px ?? null);

	function storedWidth(): PreviewWidth {
		try {
			const w = localStorage.getItem(WIDTH_KEY);
			if (PREVIEW_WIDTHS.some((p) => p.id === w)) return w as PreviewWidth;
		} catch {
			// No storage: the default.
		}
		return 'full';
	}

	function setWidth(w: PreviewWidth): void {
		width = w;
		try {
			localStorage.setItem(WIDTH_KEY, w);
		} catch {
			// Kept for this window only.
		}
	}

	$effect(() => {
		void win.setTitle(previewTitle(path)).catch(() => {});
	});

	onMount(() => {
		const stops = [
			win.listen(PREVIEW_CHANGED_EVENT, () => {
				reloads += 1;
			}),
			win.listen<PreviewNavigate>(PREVIEW_NAVIGATE_EVENT, (e) => {
				url = e.payload.url;
				path = e.payload.path;
				reloads = 0;
			})
		];
		return () => {
			for (const s of stops) void s.then((stop) => stop());
		};
	});
</script>

<svelte:window onstorage={followSettingsStorage} />

<div class="preview-window">
	<PreviewToolbar
		{path}
		{url}
		{width}
		onReload={() => (reloads += 1)}
		onWidth={setWidth}
		onOpenInBrowser={() => void openInBrowser(url)}
	/>
	<div class="stage">
		{#if url}
			<iframe
				title={path}
				{src}
				style:width={px === null ? '100%' : `${px}px`}
				sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
				referrerpolicy="no-referrer"
			></iframe>
		{:else}
			<p class="empty">No page to show.</p>
		{/if}
	</div>
</div>

<style>
	.preview-window {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
		background: var(--bg-primary);
	}
	.stage {
		flex: 1 1 auto;
		display: flex;
		justify-content: center;
		overflow: auto;
		background: var(--bg-secondary);
	}
	iframe {
		height: 100%;
		flex: 0 0 auto;
		border: 0;
		background: white;
	}
	.empty {
		margin: auto;
		color: var(--text-secondary);
	}
</style>
