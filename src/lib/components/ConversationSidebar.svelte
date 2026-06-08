<script lang="ts">
	/**
	 * Left-rail conversation list with inline rename, per-row delete,
	 * "+ New Chat" button, collapse toggle, and a "Clear all" footer.
	 *
	 * Reads from and writes back to the chat store directly — no props,
	 * no emitted events. The root route mounts this once and forgets it.
	 *
	 * Rename UX: double-click a row to enter rename mode, Enter to
	 * commit, Escape (or blur) to cancel. Active row is highlighted.
	 */
	import {
		clearAllConversations,
		createConversation,
		deleteConversation,
		getActiveConversationId,
		getConversations,
		renameConversation,
		setActiveConversation
	} from '$lib/stores/chat.svelte';

	let collapsed = $state(false);
	let renamingId = $state<string | null>(null);
	let renameText = $state('');

	const conversations = $derived(getConversations());
	const activeId = $derived(getActiveConversationId());

	function startRename(id: string, currentTitle: string) {
		renamingId = id;
		renameText = currentTitle;
	}

	function finishRename() {
		if (renamingId && renameText.trim()) {
			renameConversation(renamingId, renameText.trim());
		}
		renamingId = null;
	}

	function handleRenameKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			finishRename();
		} else if (e.key === 'Escape') {
			renamingId = null;
		}
	}
</script>

<aside class="sidebar" class:collapsed>
	<div class="sidebar-header">
		{#if !collapsed}
			<button class="new-chat-btn" onclick={() => createConversation()}>+ New Chat</button>
		{/if}
		<button
			class="collapse-btn"
			onclick={() => (collapsed = !collapsed)}
			title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
		>
			{collapsed ? '▶' : '◀'}
		</button>
	</div>
	{#if !collapsed}
		<div class="conversation-list thin-scroll">
			{#each conversations as conv (conv.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="conversation-item"
					class:active={conv.id === activeId}
					onclick={() => setActiveConversation(conv.id)}
					ondblclick={(e) => {
						e.stopPropagation();
						startRename(conv.id, conv.title);
					}}
				>
					{#if renamingId === conv.id}
						<input
							class="rename-input"
							type="text"
							bind:value={renameText}
							onblur={finishRename}
							onkeydown={handleRenameKeydown}
							onclick={(e) => e.stopPropagation()}
						/>
					{:else}
						<span class="conv-title">{conv.title}</span>
					{/if}
					<button
						class="delete-btn"
						onclick={(e) => {
							e.stopPropagation();
							deleteConversation(conv.id);
						}}
						title="Delete conversation"
					>
						&times;
					</button>
				</div>
			{/each}
		</div>
		{#if conversations.length > 0}
			<div class="sidebar-footer">
				<button
					class="clear-all-btn"
					onclick={() => {
						if (confirm('Delete all conversations?')) clearAllConversations();
					}}
				>
					Clear all
				</button>
			</div>
		{/if}
	{/if}
</aside>

<style>
	.sidebar {
		width: 260px;
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		background: var(--bg-secondary);
		transition: width 0.2s ease;
	}
	.sidebar.collapsed {
		width: 40px;
	}
	.sidebar-header {
		display: flex;
		align-items: center;
		padding: 8px;
		gap: 4px;
		border-bottom: 1px solid var(--border);
	}
	.new-chat-btn {
		flex: 1;
		padding: 6px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.85rem;
		text-align: left;
	}
	.new-chat-btn:hover {
		background: var(--bg-secondary);
	}
	.collapse-btn {
		background: none;
		border: none;
		cursor: pointer;
		padding: 4px 6px;
		font-size: 0.7rem;
		color: var(--text-secondary);
	}
	.conversation-list {
		flex: 1;
		overflow-x: hidden;
		overflow-y: auto;
		scrollbar-gutter: stable;
		padding: 4px 8px 4px 4px;
	}
	.conversation-item {
		display: flex;
		align-items: center;
		width: 100%;
		padding: 8px 10px;
		border: none;
		border-radius: 6px;
		background: none;
		cursor: pointer;
		text-align: left;
		font-size: 0.85rem;
		color: var(--text-primary);
		gap: 4px;
	}
	.conversation-item:hover {
		background: var(--bg-primary);
	}
	.conversation-item.active {
		background: var(--bg-primary);
		font-weight: 500;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
	}
	.conv-title {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.delete-btn {
		background: none;
		border: none;
		cursor: pointer;
		color: var(--text-secondary);
		font-size: 1rem;
		padding: 0 4px;
		margin-right: 2px;
		opacity: 0;
		transition: opacity 0.15s;
		flex-shrink: 0;
	}
	.conversation-item:hover .delete-btn {
		opacity: 1;
	}
	.delete-btn:hover {
		color: var(--error-text);
	}
	.rename-input {
		flex: 1;
		padding: 2px 6px;
		border: 1px solid var(--accent);
		border-radius: 4px;
		font-size: 0.85rem;
		background: var(--bg-primary);
		color: var(--text-primary);
		outline: none;
		min-width: 0;
	}
	.sidebar-footer {
		padding: 8px;
		border-top: 1px solid var(--border);
	}
	.clear-all-btn {
		width: 100%;
		padding: 6px;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--text-secondary);
		font-size: 0.8rem;
		cursor: pointer;
	}
	.clear-all-btn:hover {
		color: var(--error-text);
		background: var(--error-bg);
	}
</style>
