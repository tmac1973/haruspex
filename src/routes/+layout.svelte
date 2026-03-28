<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import ServerStatusBadge from '$lib/components/ServerStatusBadge.svelte';
	import { initServerStore } from '$lib/stores/server.svelte';
	import { onMount } from 'svelte';

	let { children } = $props();

	onMount(() => {
		initServerStore();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header>
	<h1>Haruspex</h1>
	<ServerStatusBadge />
</header>

<main>
	{@render children()}
</main>

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
		:global(:root) {
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

	main {
		flex: 1;
		overflow: hidden;
	}
</style>
