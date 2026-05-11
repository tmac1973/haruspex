<script lang="ts">
	/**
	 * Modal shown when the model tries to run code in the Python sandbox
	 * and the user hasn't already approved code execution for this chat.
	 * Mounted once in the root layout — subscribes to the sandboxApproval
	 * store and becomes visible whenever a prompt is pending.
	 *
	 * Buttons depend on the mode:
	 *   - once-per-chat: Allow once / Allow for this chat / Deny
	 *   - every-run:     Allow / Deny
	 *
	 * Backdrop and Esc don't dismiss — same intentional restriction as
	 * FileConflictModal: silent dismiss of "is it OK to run code?" is a
	 * footgun.
	 */
	import { getPendingApproval, resolveApproval } from '$lib/stores/sandboxApproval.svelte';

	const pending = $derived(getPendingApproval());
</script>

{#if pending}
	<div class="modal-backdrop">
		<div class="modal" role="dialog" aria-modal="true" aria-labelledby="sandbox-approval-title">
			<h2 id="sandbox-approval-title">Allow code execution?</h2>
			<p>The model wants to run Python in this chat:</p>
			<pre class="code-preview"><code>{pending.code}</code></pre>
			<div class="button-row">
				{#if pending.mode === 'once-per-chat'}
					<button class="btn allow" onclick={() => resolveApproval('allow_chat')}>
						<strong>Allow for this chat</strong>
						<span>Don't ask again until I switch chats</span>
					</button>
					<button class="btn allow-once" onclick={() => resolveApproval('allow_once')}>
						<strong>Allow once</strong>
						<span>Run this code, ask again next time</span>
					</button>
				{:else}
					<button class="btn allow-once" onclick={() => resolveApproval('allow_once')}>
						<strong>Allow</strong>
						<span>Run this code</span>
					</button>
				{/if}
				<button class="btn deny" onclick={() => resolveApproval('deny')}>
					<strong>Deny</strong>
					<span>Don't run; the model will see an error</span>
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 24px;
	}

	.modal {
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 24px 28px;
		max-width: 640px;
		width: 100%;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
	}

	.modal h2 {
		margin: 0 0 12px 0;
		font-size: 1.15rem;
		color: var(--text-primary);
	}

	.modal p {
		margin: 0 0 10px 0;
		color: var(--text-primary);
		font-size: 0.9rem;
		line-height: 1.5;
	}

	.code-preview {
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 10px 12px;
		max-height: 280px;
		overflow: auto;
		font-size: 0.82rem;
		line-height: 1.45;
		margin: 8px 0 16px 0;
	}

	.code-preview code {
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		white-space: pre;
	}

	.button-row {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.btn {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		text-align: left;
		padding: 12px 16px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.btn:hover {
		border-color: var(--accent);
	}

	.btn strong {
		display: block;
		font-size: 0.92rem;
		margin-bottom: 2px;
	}

	.btn span {
		display: block;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.btn.deny:hover {
		border-color: #ef4444;
	}
</style>
