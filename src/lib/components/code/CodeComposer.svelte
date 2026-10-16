<script lang="ts">
	/**
	 * The input box. Idle, Enter starts a turn; while the agent works, Enter
	 * queues the text as a steering message for its next step. Steering a
	 * stopped turn never delivered comes back into the box, and so does a
	 * message stopped while it waited in the queue. When the session's folder
	 * is gone the box is disabled and says why.
	 */
	import { onMount, tick, untrack } from 'svelte';
	import MicButton from '#lib/components/MicButton.svelte';
	import SlashMenu from '#lib/components/SlashMenu.svelte';
	import ScreenCaptureButton from '#lib/components/ScreenCaptureButton.svelte';
	import { messageText } from '#lib/api.ts';
	import { InputHistory, placeCaret, recallInto, sentHistory } from '#lib/inputHistory.ts';
	import { isWatchNotification } from '#lib/shell/backgroundWatch.ts';
	import { isSubtaskNotification } from '#lib/code/backgroundSubtasks.ts';

	/** A turn Haruspex sent on the user's behalf, not one they typed. */
	const isNotification = (text: string) => isWatchNotification(text) || isSubtaskNotification(text);
	import { runSlash, type SlashHost } from '#lib/slash/slash.ts';
	import { typedText } from '#lib/skills/content.ts';
	import type { CodeSession } from '#lib/stores/code.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { createPendingImages } from '#lib/utils/pendingImages.svelte.ts';
	import { imageDropTarget } from '#lib/utils/imageDrop.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { session, slashHost }: { session: CodeSession; slashHost: SlashHost } = $props();

	let text = $state('');
	let el = $state<HTMLTextAreaElement | null>(null);
	let slashMenu = $state<SlashMenu>();
	const images = createPendingImages();
	let dragOver = $state(false);

	const busy = $derived(session.busy);
	/** Why nothing can be sent, or null. */
	const blocked = $derived(session.folderMissing ? `Folder not found: ${session.root}` : null);

	// Unsent input moves with the session to another window.
	onMount(() => session.setDraftReader(() => ({ text, images: images.urls })));

	// A turn that ended with steering it never delivered hands it back, as
	// does one stopped before it started (with its images).
	$effect(() => {
		if (session.returnedSteering.length === 0 && session.returnedImages.length === 0) return;
		untrack(() => {
			const back = session.takeReturnedSteering();
			text = [...back, text].filter((t) => t.trim()).join('\n\n');
			const imgs = session.takeReturnedImages();
			if (imgs.length) images.prepend(imgs);
		});
		void tick().then(autosize);
	});

	// A fork opens with its input box focused, holding the forked message.
	$effect(() => {
		if (!session.prefill) return;
		untrack(() => {
			const p = session.takePrefill();
			if (!p) return;
			if (p.text) text = p.text;
			if (p.images.length) images.set(p.images);
		});
		void tick().then(() => {
			autosize();
			el?.focus();
			if (el) placeCaret(el, 'end');
		});
	});

	function autosize() {
		if (!el) return;
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 200) + 'px';
	}

	async function send(raw: string) {
		if (blocked) return;
		const urls = images.urls;
		if (!raw.trim() && urls.length === 0) return;
		if (busy) {
			// Steering: no slash commands mid-turn.
			text = '';
			autosize();
			history.reset();
			images.clear();
			await session.send(raw, { images: urls });
			return;
		}
		let slash;
		try {
			slash = await runSlash(raw, slashHost);
		} catch (e) {
			showToast(`Couldn't run that skill: ${errMessage(e)}`, { kind: 'error' });
			return;
		}
		text = '';
		autosize();
		history.reset();
		if (slash.kind === 'handled') return;
		images.clear();
		await session.send(raw, { images: urls, skill: slash.skill });
	}

	const history = new InputHistory(() =>
		sentHistory(
			session.messages
				.filter((m) => m.role === 'user' && !isNotification(messageText(m.content)))
				.map((m) => typedText(messageText(m.content)))
		)
	);

	function onKeydown(event: KeyboardEvent) {
		if (!busy && slashMenu?.handleKey(event)) return;
		const show = (recalled: string) => {
			text = recalled;
			slashMenu?.dismiss(recalled);
		};
		if (recallInto(history, event, el, show, autosize)) return;
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void send(text);
		} else if (event.key === 'Escape' && busy) {
			event.preventDefault();
			session.stop();
		}
	}
</script>

<footer
	class="composer"
	class:drag-over={dragOver}
	use:imageDropTarget={{
		onImages: images.addUrls,
		onDragChange: (over) => (dragOver = over)
	}}
>
	{#if images.length}
		<div class="attachments">
			{#each images.items as img (img.id)}
				<div class="attachment">
					<img src={img.url} alt="attachment" />
					<button class="remove" title="Remove image" onclick={() => images.remove(img.id)}
						>×</button
					>
				</div>
			{/each}
		</div>
	{/if}
	{#if !busy && !blocked}
		<SlashMenu
			bind:this={slashMenu}
			{text}
			projectRoot={slashHost.projectRoot}
			codeMode
			compact={slashHost.compact !== undefined}
			onPick={(t) => {
				text = t;
				el?.focus();
			}}
		/>
	{/if}
	<textarea
		bind:this={el}
		bind:value={text}
		oninput={autosize}
		onkeydown={onKeydown}
		onpaste={images.onPaste}
		rows="1"
		aria-label="Message"
		disabled={!!blocked && !busy}
		title={blocked ?? undefined}
		placeholder={blocked && !busy
			? blocked
			: busy
				? 'Steer the agent… (Enter queues it for its next step)'
				: 'Ask for a change… (Enter to send, / for commands)'}></textarea>
	{#if !blocked}
		<ScreenCaptureButton onCapture={(url) => images.addUrls([url])} />
		<MicButton onTranscription={(t) => send(t)} />
	{/if}
	{#if busy}
		<button class="stop" onclick={session.stop} title="Stop (Esc)">Stop</button>
	{:else}
		<button
			class="send"
			onclick={() => send(text)}
			disabled={!!blocked || (!text.trim() && images.length === 0)}
			title={blocked ?? 'Send (Enter)'}>Send</button
		>
	{/if}
</footer>

<style>
	.composer {
		position: relative;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: flex-end;
		padding: 8px 12px 10px;
		border-top: 1px solid var(--border);
		background: var(--bg-primary);
		flex-shrink: 0;
	}

	.composer.drag-over {
		background: color-mix(in srgb, var(--accent) 12%, var(--bg-primary));
		outline: 2px dashed var(--accent);
		outline-offset: -4px;
	}

	.attachments {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		width: 100%;
	}

	.attachment {
		position: relative;
		width: 56px;
		height: 56px;
		border-radius: 6px;
		overflow: hidden;
		border: 1px solid var(--border);
	}

	.attachment img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.attachment .remove {
		position: absolute;
		top: 1px;
		right: 1px;
		width: 18px;
		height: 18px;
		line-height: 16px;
		padding: 0;
		border: none;
		border-radius: 4px;
		background: rgba(0, 0, 0, 0.6);
		color: white;
		font-size: 14px;
		cursor: pointer;
	}

	textarea {
		flex: 1;
		min-height: 38px;
		max-height: 200px;
		resize: none;
		padding: 8px 10px;
		font-family: inherit;
		font-size: 0.88rem;
		line-height: 1.4;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--bg-input);
		color: var(--text-primary);
		outline: none;
	}

	textarea:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	textarea:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 15%, transparent);
	}

	.send,
	.stop {
		appearance: none;
		padding: 8px 16px;
		font-size: 0.82rem;
		font-weight: 500;
		border-radius: 7px;
		cursor: pointer;
	}

	/* Filled, so accent-contrast. */
	.send {
		background: var(--accent);
		color: var(--accent-contrast);
		border: 1px solid var(--accent);
	}

	.send:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.stop {
		background: none;
		color: var(--text-primary);
		border: 1px solid var(--border-strong);
	}
</style>
