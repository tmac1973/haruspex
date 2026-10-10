<script lang="ts">
	/**
	 * The input box. Idle, Enter starts a turn; while the agent works, Enter
	 * queues the text to steer its next step, as on the computer (`steer`: a
	 * Code session; chat can't be steered, so it waits). Shift+Enter is a new
	 * line. `why`: the tooltip saying why it's disabled.
	 */
	let {
		busy,
		disabled = false,
		steer = true,
		why = null,
		onsend,
		onstop
	}: {
		busy: boolean;
		disabled?: boolean;
		steer?: boolean;
		why?: string | null;
		onsend: (text: string) => Promise<boolean>;
		onstop: () => void;
	} = $props();

	const blocked = $derived(disabled || (busy && !steer));

	let text = $state('');
	let sending = $state(false);

	async function send(): Promise<void> {
		const t = text.trim();
		if (!t || sending || blocked) return;
		sending = true;
		// Kept until the computer has it, so a dropped connection loses nothing.
		if (await onsend(t)) text = '';
		sending = false;
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void send();
		}
	}
</script>

<div class="composer">
	<textarea
		aria-label="Message"
		rows="2"
		placeholder={busy
			? steer
				? 'Steer the agent… (Enter queues it for its next step)'
				: 'The reply is being written…'
			: steer
				? 'Ask for a change…'
				: 'Message…'}
		title={why ?? undefined}
		bind:value={text}
		onkeydown={onKeydown}
		{disabled}
	></textarea>
	<div class="buttons">
		{#if busy}
			<button class="btn btn-small btn-danger" onclick={onstop}>Stop</button>
		{/if}
		<button
			class="btn btn-small btn-primary"
			onclick={send}
			title={why ?? undefined}
			disabled={blocked || sending || !text.trim()}>{busy && steer ? 'Queue' : 'Send'}</button
		>
	</div>
</div>

<style>
	.composer {
		display: flex;
		gap: 8px;
		align-items: flex-end;
		padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
		border-top: 1px solid var(--border);
		background: var(--bg-primary);
	}

	textarea {
		flex: 1;
		min-width: 0;
		resize: none;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		/* 16px or more: iOS zooms into smaller inputs. */
		font-size: 16px;
	}

	.buttons {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
</style>
