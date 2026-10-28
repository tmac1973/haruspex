<script lang="ts">
	/**
	 * The input box. Idle, Enter starts a turn; while the agent works, Enter
	 * queues the text to steer its next step, as on the computer (`steer`
	 * false: it waits instead). Shift+Enter is a new line. `why`: the tooltip
	 * saying why it's disabled. Pictures come from 📎 or a paste, downscaled
	 * as the computer's input box downscales them, and go with the message.
	 */
	import { imageFileToDataUrl, imageFilesFrom } from '#lib/utils/image.ts';

	/** As many as the computer takes with one message. */
	const MAX_PICTURES = 8;

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
		onsend: (text: string, pictures: string[]) => Promise<boolean>;
		onstop: () => void;
	} = $props();

	const blocked = $derived(disabled || (busy && !steer));

	let text = $state('');
	let pictures = $state<string[]>([]);
	let sending = $state(false);
	let picker = $state<HTMLInputElement | null>(null);

	async function add(files: File[]): Promise<void> {
		const room = MAX_PICTURES - pictures.length;
		const urls = await Promise.all(files.slice(0, room).map((f) => imageFileToDataUrl(f)));
		pictures = [...pictures, ...urls];
	}

	function onPaste(e: ClipboardEvent): void {
		const files = imageFilesFrom(e.clipboardData);
		if (!files.length) return;
		e.preventDefault();
		void add(files);
	}

	async function send(): Promise<void> {
		const t = text.trim();
		if ((!t && pictures.length === 0) || sending || blocked) return;
		sending = true;
		// Kept until the computer has it, so a dropped connection loses nothing.
		if (await onsend(t, pictures)) {
			text = '';
			pictures = [];
		}
		sending = false;
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void send();
		}
	}
</script>

{#if pictures.length}
	<div class="pictures">
		{#each pictures as url, i (i)}
			<div class="picture">
				<img src={url} alt="Attached picture {i + 1}" />
				<button
					class="remove"
					aria-label="Remove picture {i + 1}"
					onclick={() => (pictures = pictures.filter((_, j) => j !== i))}>×</button
				>
			</div>
		{/each}
	</div>
{/if}
<div class="composer">
	<input
		bind:this={picker}
		type="file"
		accept="image/png,image/jpeg,image/webp,image/gif"
		multiple
		hidden
		onchange={(e) => {
			void add(Array.from(e.currentTarget.files ?? []));
			e.currentTarget.value = '';
		}}
	/>
	<button
		class="btn btn-small attach"
		aria-label="Attach a picture"
		title="Attach a picture (or paste one)"
		disabled={disabled || pictures.length >= MAX_PICTURES}
		onclick={() => picker?.click()}>📎</button
	>
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
		onpaste={onPaste}
		{disabled}></textarea>
	<div class="buttons">
		{#if busy}
			<button class="btn btn-small btn-danger" onclick={onstop}>Stop</button>
		{/if}
		<button
			class="btn btn-small btn-primary"
			onclick={send}
			title={why ?? undefined}
			disabled={blocked || sending || (!text.trim() && pictures.length === 0)}
			>{busy && steer ? 'Queue' : 'Send'}</button
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

	.pictures {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		padding: 8px 12px 0;
		border-top: 1px solid var(--border);
		background: var(--bg-primary);
	}

	.picture {
		position: relative;
	}

	.picture img {
		width: 56px;
		height: 56px;
		object-fit: cover;
		border-radius: 6px;
		border: 1px solid var(--border);
	}

	.remove {
		position: absolute;
		top: -6px;
		right: -6px;
		width: 20px;
		height: 20px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: var(--bg-secondary, #444);
		color: var(--text-primary);
		line-height: 20px;
		cursor: pointer;
	}

	.attach {
		align-self: flex-end;
	}

	.buttons {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
</style>
