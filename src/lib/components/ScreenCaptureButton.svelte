<script lang="ts">
	/**
	 * The composer's camera button, shared by Chat, Shell and Code: the whole
	 * screen, one window, or a region dragged out of the screen. Chat and Code
	 * attach it to the message being written; Shell sends it at once.
	 *
	 * A person pressing this is not the Settings → Screen question, which is
	 * about the assistant asking. Window picking is the desktop portal's picker
	 * on Linux and a list of open windows elsewhere, opening above the nearest
	 * positioned ancestor (the composer).
	 */
	import { invoke } from '@tauri-apps/api/core';
	import RegionSelector from '#lib/components/RegionSelector.svelte';
	import WindowPicker from '#lib/components/WindowPicker.svelte';
	import type { CaptureRect } from '#lib/ipc/gen/CaptureRect.ts';
	import type { CaptureWindow } from '#lib/ipc/gen/CaptureWindow.ts';
	import type { ScreenCapture } from '#lib/ipc/gen/ScreenCapture.ts';
	import { finishRegionCapture, startRegionCapture } from '#lib/shell/captureRegion.ts';
	import { captureWindowImage, windowsToPick } from '#lib/shell/captureWindow.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import { onDestroy } from 'svelte';

	let {
		onCapture,
		disabled = false,
		title = 'Attach a screenshot to this message',
		label = 'Attach a screenshot'
	}: {
		onCapture: (dataUrl: string) => void | Promise<void>;
		disabled?: boolean;
		title?: string;
		label?: string;
	} = $props();

	let busy = $state(false);
	let menuOpen = $state(false);
	let windowChoices = $state<CaptureWindow[] | null>(null);
	/** The screen to drag a region on, between the capture and the crop. */
	let regionPreview = $state<ScreenCapture | null>(null);

	/** Run one capture, reporting a failure (or a cancelled portal) as a toast. */
	async function run(work: () => Promise<void>) {
		menuOpen = false;
		if (busy || disabled) return;
		busy = true;
		try {
			await work();
		} catch (e) {
			showToast(errMessage(e), { kind: 'error' });
		} finally {
			busy = false;
		}
	}

	const screen = () =>
		run(async () => {
			const capture = await invoke<ScreenCapture>('capture_screen', { target: 'screen' });
			await onCapture(capture.dataUrl);
		});

	const oneWindow = () =>
		run(async () => {
			const windows = await windowsToPick();
			if (windows.length === 0) await onCapture(await captureWindowImage(null));
			else windowChoices = windows;
		});

	function pickWindow(id: number) {
		windowChoices = null;
		void run(async () => onCapture(await captureWindowImage(id)));
	}

	const region = () =>
		run(async () => {
			regionPreview = await startRegionCapture();
		});

	function regionDone(rect: CaptureRect | null) {
		regionPreview = null;
		void run(async () => {
			const url = await finishRegionCapture(rect);
			if (url) await onCapture(url);
		});
	}

	// Leaving the chat mid-selection must not leave the frame held in Rust.
	onDestroy(() => {
		if (regionPreview) void finishRegionCapture(null).catch(() => {});
	});
</script>

<svelte:window
	onkeydown={(e) => {
		if (menuOpen && e.key === 'Escape') menuOpen = false;
	}}
/>

{#if windowChoices}
	<WindowPicker
		windows={windowChoices}
		onPick={pickWindow}
		onCancel={() => (windowChoices = null)}
	/>
{/if}
{#if regionPreview}
	<RegionSelector preview={regionPreview} onDone={regionDone} />
{/if}
<span class="capture">
	{#if menuOpen}
		<div class="capture-menu" role="menu" aria-label="Capture">
			<button role="menuitem" onclick={screen} title="The whole primary display">Screen</button>
			<button role="menuitem" onclick={oneWindow} title="One window you pick">Window…</button>
			<button
				role="menuitem"
				onclick={region}
				title="Haruspex hides while the screen is taken, then you drag out the part to attach"
				>Region…</button
			>
		</div>
	{/if}
	<button
		class="capture-btn"
		onclick={() => (menuOpen = !menuOpen)}
		disabled={disabled || busy}
		{title}
		aria-label={label}
		aria-haspopup="menu"
		aria-expanded={menuOpen}
	>
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
			></path>
			<circle cx="12" cy="13" r="4"></circle>
		</svg>
	</button>
</span>

<style>
	.capture {
		position: relative;
		display: flex;
		flex-shrink: 0;
	}

	.capture-btn {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-secondary);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s;
	}

	.capture-btn:hover:not(:disabled) {
		color: var(--text-primary);
		border-color: var(--text-secondary);
	}

	.capture-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.capture-menu {
		position: absolute;
		bottom: calc(100% + 4px);
		left: 50%;
		transform: translateX(-50%);
		z-index: 10;
		display: flex;
		flex-direction: column;
		min-width: 110px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		overflow: hidden;
	}

	.capture-menu button {
		text-align: left;
		padding: 6px 10px;
		border: none;
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.85rem;
	}

	.capture-menu button + button {
		border-top: 1px solid var(--border);
	}

	.capture-menu button:hover {
		background: var(--bg-primary);
	}
</style>
