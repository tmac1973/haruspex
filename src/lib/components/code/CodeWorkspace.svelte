<script lang="ts">
	/**
	 * The Code tab: saved sessions on the left, open ones as sub-tabs, and the
	 * active one's pane. Mounted once and kept (see `+page.svelte`), so turns
	 * and background processes carry on while another tab is showing.
	 */
	import CodeSidebar from './CodeSidebar.svelte';
	import CodeTabStrip from './CodeTabStrip.svelte';
	import CodePane from './CodePane.svelte';
	import NewSessionDialog from './NewSessionDialog.svelte';
	import { getActiveSessionId, getOpenSessions } from '#lib/stores/code.svelte.ts';

	const sessions = $derived(getOpenSessions());
	const activeId = $derived(getActiveSessionId());

	let dialogOpen = $state(false);
	const openDialog = () => (dialogOpen = true);
</script>

<div class="workspace">
	<CodeSidebar onNew={openDialog} />
	<div class="main">
		{#if sessions.length > 0}
			<CodeTabStrip onNew={openDialog} />
			<div class="panes">
				{#each sessions as session (session.id)}
					<!-- Every pane stays mounted so a turn's streaming state and the
					     input box survive switching sub-tabs. -->
					<div class="pane-host" class:hidden={session.id !== activeId}>
						<CodePane {session} />
					</div>
				{/each}
			</div>
		{:else}
			<div class="empty">
				<p>Start a session in a project folder, or open one from the list.</p>
				<button class="btn btn-primary" onclick={openDialog}>New session</button>
			</div>
		{/if}
	</div>
</div>

<NewSessionDialog open={dialogOpen} onclose={() => (dialogOpen = false)} />

<style>
	.workspace {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}

	.main {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
	}

	.panes {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}

	.pane-host {
		display: flex;
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
	}

	.pane-host.hidden {
		display: none;
	}

	.empty {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.empty p {
		margin: 0;
	}
</style>
