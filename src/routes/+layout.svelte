<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import ServerStatusBadge from '$lib/components/ServerStatusBadge.svelte';
	import ContextIndicator from '$lib/components/ContextIndicator.svelte';
	import LogViewer from '$lib/components/LogViewer.svelte';
	import GpuWarningDialog from '$lib/components/GpuWarningDialog.svelte';
	import { initChatStore } from '$lib/stores/chat.svelte';
	import { initServerStore, startServer } from '$lib/stores/server.svelte';
	import { applyTheme, getSettings, getThinkingModeArgs } from '$lib/stores/settings';
	import { invoke } from '@tauri-apps/api/core';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';

	let { children } = $props();
	let showLogs = $state(false);
	let showGpuWarning = $state(false);

	onMount(async () => {
		applyTheme();
		initServerStore();
		initChatStore();

		// Intercept clicks on external links and open in system browser
		document.addEventListener('click', (e) => {
			const anchor = (e.target as HTMLElement).closest('a');
			if (!anchor) return;
			const href = anchor.getAttribute('href');
			if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
				e.preventDefault();
				invoke('plugin:shell|open', { path: href }).catch(() => {
					window.open(href, '_blank');
				});
			}
		});

		// First-run detection: redirect to setup if no model found
		try {
			const hasModel = await invoke<boolean>('has_any_model');
			if (!hasModel && !page.url.pathname.startsWith('/setup')) {
				goto('/setup');
			} else if (hasModel && !page.url.pathname.startsWith('/setup')) {
				// Auto-start server with available model
				const modelPath = await invoke<string | null>('get_active_model_path');
				if (modelPath) {
					startServer(modelPath, getSettings().contextSize, getThinkingModeArgs());
				}
				// Eagerly start TTS in the background (non-blocking)
				invoke('tts_initialize').catch((e) => console.warn('TTS init failed:', e));
			}
		} catch {
			// Tauri commands not available (e.g., in browser dev mode)
		}

		if (!getSettings().dismissedGpuWarning) {
			showGpuWarning = true;
		}
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header>
	<h1>Haruspex</h1>
	<div class="header-right">
		<ServerStatusBadge />
		<ContextIndicator />
		<button class="header-icon-btn" title="Sidecar Logs" onclick={() => (showLogs = !showLogs)}>
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
				<polyline points="4 17 10 11 4 5"></polyline>
				<line x1="12" y1="19" x2="20" y2="19"></line>
			</svg>
		</button>
		<a href="/settings" class="settings-link" title="Settings">
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
				<circle cx="12" cy="12" r="3"></circle>
				<path
					d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
				></path>
			</svg>
		</a>
	</div>
</header>

<main>
	{@render children()}
</main>

<LogViewer open={showLogs} onclose={() => (showLogs = false)} />

{#if showGpuWarning}
	<GpuWarningDialog onclose={() => (showGpuWarning = false)} />
{/if}

<style>
	:global(:root) {
		--bg-primary: #ffffff;
		--bg-secondary: #f9fafb;
		--bg-chat: #ffffff;
		--text-primary: #1a1a1a;
		--text-secondary: #6b7280;
		--accent: #3b82f6;
		--border: #e5e7eb;
		--code-bg: #1e1e1e;
		--user-bubble: #eff6ff;
		--error-bg: #fef2f2;
		--error-text: #dc2626;
		--error-border: #fecaca;
	}

	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light'])) {
			--bg-primary: #111111;
			--bg-secondary: #1a1a1a;
			--bg-chat: #111111;
			--text-primary: #e5e5e5;
			--text-secondary: #9ca3af;
			--accent: #60a5fa;
			--border: #2e2e2e;
			--code-bg: #0d0d0d;
			--user-bubble: #1e293b;
			--error-bg: #1c1111;
			--error-text: #f87171;
			--error-border: #3b1111;
		}
	}

	:global(:root[data-theme='dark']) {
		--bg-primary: #111111;
		--bg-secondary: #1a1a1a;
		--bg-chat: #111111;
		--text-primary: #e5e5e5;
		--text-secondary: #9ca3af;
		--accent: #60a5fa;
		--border: #2e2e2e;
		--code-bg: #0d0d0d;
		--user-bubble: #1e293b;
		--error-bg: #1c1111;
		--error-text: #f87171;
		--error-border: #3b1111;
	}

	:global(html),
	:global(body) {
		height: 100%;
		overflow: hidden;
		margin: 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 16px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-primary);
	}

	header h1 {
		font-size: 1.1rem;
		margin: 0;
		font-weight: 600;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.header-icon-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		padding: 4px;
		border-radius: 4px;
		cursor: pointer;
		transition: color 0.15s;
	}

	.header-icon-btn:hover {
		color: var(--text-primary);
	}

	.settings-link {
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		padding: 4px;
		border-radius: 4px;
		transition: color 0.15s;
	}

	.settings-link:hover {
		color: var(--text-primary);
	}

	main {
		flex: 1;
		overflow: hidden;
	}
</style>
