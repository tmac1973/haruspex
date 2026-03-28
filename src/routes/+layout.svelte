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
	:global(body) {
		margin: 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		background: var(--bg-primary, #ffffff);
		color: var(--text-primary, #1a1a1a);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 16px;
		border-bottom: 1px solid var(--border, #e5e7eb);
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

	:global(html),
	:global(body) {
		height: 100%;
		overflow: hidden;
	}
</style>
