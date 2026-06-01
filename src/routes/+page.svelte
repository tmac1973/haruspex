<script lang="ts">
	import TabBar from '$lib/components/TabBar.svelte';
	import ChatView from '$lib/components/ChatView.svelte';
	import JobsTab from '$lib/components/jobs/JobsTab.svelte';
	import ShellTab from '$lib/components/shell/ShellTab.svelte';
	import { getActiveTab } from '$lib/stores/activeTab.svelte';

	const activeTab = $derived(getActiveTab());

	// Lazy-mount Shell once, then keep it alive across tab switches so the
	// PTY survives. Chat and Jobs use the regular unmount-on-switch model
	// — they own no live process the user expects to persist.
	let shellEverOpened = $state(false);
	$effect(() => {
		if (activeTab === 'shell') shellEverOpened = true;
	});
</script>

<div class="page-layout">
	<TabBar />
	{#if activeTab === 'chat'}
		<ChatView />
	{:else if activeTab === 'jobs'}
		<JobsTab />
	{/if}
	{#if shellEverOpened}
		<div class="shell-host" class:hidden={activeTab !== 'shell'}>
			<ShellTab />
		</div>
	{/if}
</div>

<style>
	.page-layout {
		display: flex;
		flex-direction: column;
		height: calc(100vh - 45px);
		overflow: hidden;
	}

	.shell-host {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}

	.shell-host.hidden {
		display: none;
	}
</style>
