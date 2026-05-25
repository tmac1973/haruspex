<script lang="ts">
	import TabBar from '$lib/components/TabBar.svelte';
	import ChatView from '$lib/components/ChatView.svelte';
	import JobsTab from '$lib/components/jobs/JobsTab.svelte';
	import WorkspaceTab from '$lib/components/workspace/WorkspaceTab.svelte';
	import { getActiveTab } from '$lib/stores/activeTab.svelte';

	const activeTab = $derived(getActiveTab());
</script>

<div class="page-layout">
	<TabBar />
	<div class="tab-body">
		{#if activeTab === 'chat'}
			<ChatView />
		{:else if activeTab === 'jobs'}
			<JobsTab />
		{/if}
		<!--
			WorkspaceTab is kept mounted at all times even when inactive.
			Reason: pool.host lives inside it and contains the per-chat
			Pyodide iframes. An iframe disconnected from the document
			tree won't load its src, so unmounting would stall every
			run_python call until timeout. visibility-hidden lets the
			iframe's event loop keep ticking (pygame loops stay alive
			across chat-tab visits).
		-->
		<div class="workspace-wrap" class:active={activeTab === 'workspace'}>
			<WorkspaceTab />
		</div>
	</div>
</div>

<style>
	.page-layout {
		display: flex;
		flex-direction: column;
		height: calc(100vh - 45px);
		overflow: hidden;
	}
	.tab-body {
		flex: 1;
		min-height: 0;
		position: relative;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.workspace-wrap {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		visibility: hidden;
		pointer-events: none;
		background: var(--bg-primary);
	}
	.workspace-wrap.active {
		visibility: visible;
		pointer-events: auto;
	}
</style>
