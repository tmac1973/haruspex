<script lang="ts">
	import TabBar from '$lib/components/TabBar.svelte';
	import ChatView from '$lib/components/ChatView.svelte';
	import JobsTab from '$lib/components/jobs/JobsTab.svelte';
	import { getActiveTab } from '$lib/stores/activeTab.svelte';

	const activeTab = $derived(getActiveTab());
</script>

<div class="page-layout">
	<TabBar />
	{#if activeTab === 'chat'}
		<ChatView />
	{:else}
		<JobsTab />
	{/if}
</div>

<style>
	.page-layout {
		display: flex;
		flex-direction: column;
		height: calc(100vh - 45px);
		overflow: hidden;
	}
</style>
