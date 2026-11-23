<script lang="ts">
	/**
	 * Beside a video in an editor window: its word-timed transcript. The word
	 * playing now is marked; click a word to play from it, Shift-click to
	 * select a stretch, then **Cut** strikes it and **Replace…** retypes it.
	 * The edits are a list kept beside the transcript (`#lib/video/edits.ts`);
	 * nothing here changes the clip or the project. **Send to chat** puts
	 * `/fix-speech apply <list>` in the folder's conversation.
	 */
	import { onMount, tick } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { TranscriptModel, type TranscriptIO } from '#lib/video/transcriptModel.svelte.ts';
	import { editAt, type Edit } from '#lib/video/edits.ts';
	import { sendToChat } from '#lib/editor/chatBridge.ts';
	import { clock } from '#lib/editor/waveform.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import type { SavedVoice } from '#lib/ipc/gen/SavedVoice.ts';

	interface Props {
		workdir: string;
		relPath: string;
		/** The video's time now, in seconds. */
		time: number;
		onseek: (secs: number) => void;
		ontoggleplay?: () => void;
		/** For tests. */
		io?: TranscriptIO;
	}

	let { workdir, relPath, time, onseek, ontoggleplay, io }: Props = $props();

	// svelte-ignore state_referenced_locally
	const model = new TranscriptModel(workdir, relPath, io);
	const current = $derived(model.wordAt(time));
	let voices = $state<SavedVoice[]>([]);
	let replacing = $state(false);
	let replaceText = $state('');
	let note = $state('');
	let box: HTMLElement | undefined = $state();
	let field: HTMLInputElement | undefined = $state();

	onMount(() => {
		void model.load();
		void invoke<SavedVoice[]>('voices_list')
			.then((v) => (voices = v))
			.catch(() => {});
	});

	function classOf(i: number): string {
		const e = model.edits ? editAt(model.edits.edits, model.words, i) : undefined;
		const s = model.selection;
		return [
			e?.kind === 'cut' ? 'cut' : '',
			e?.kind === 'replace' ? 'replaced' : '',
			s && i >= s.a && i <= s.b ? 'selected' : '',
			i === current ? 'current' : ''
		]
			.filter(Boolean)
			.join(' ');
	}

	function clickWord(i: number, e: MouseEvent): void {
		model.select(i, e.shiftKey);
		if (!e.shiftKey) onseek(model.words[i].start);
		box?.focus();
	}

	async function openReplace(): Promise<void> {
		if (!model.selection) return;
		replacing = true;
		replaceText = '';
		await tick();
		field?.focus();
	}

	function doReplace(): void {
		model.replace(replaceText);
		replacing = false;
		box?.focus();
	}

	function step(delta: number): void {
		const n = model.words.length;
		if (!n) return;
		const from = model.selection?.a ?? Math.max(0, current);
		const i = Math.min(n - 1, Math.max(0, from + delta));
		model.select(i);
		onseek(model.words[i].start);
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
		if (e.altKey || e.ctrlKey || e.metaKey) return;
		const actions: Record<string, () => void> = {
			' ': () => ontoggleplay?.(),
			ArrowLeft: () => step(-1),
			ArrowRight: () => step(1),
			Delete: () => model.cut(),
			Backspace: () => model.cut(),
			Enter: () => void openReplace()
		};
		const act = actions[e.key];
		if (!act) return;
		e.preventDefault();
		act();
	}

	async function save(): Promise<boolean> {
		note = '';
		try {
			await model.save();
			return true;
		} catch (e) {
			note = `Could not save: ${errMessage(e)}`;
			return false;
		}
	}

	async function send(): Promise<void> {
		if (!(await save())) return;
		const sep = workdir.includes('\\') && !workdir.includes('/') ? '\\' : '/';
		const path = `${workdir.replace(/[\\/]+$/, '')}${sep}${model.editsPath.replaceAll('/', sep)}`;
		try {
			await sendToChat({ folder: workdir, command: '/fix-speech apply', path });
			note = 'Sent to the chat box.';
		} catch (e) {
			note = `Could not reach the chat: ${errMessage(e)}`;
		}
	}

	function chipText(e: Edit): string {
		return e.kind === 'cut' ? `Cut “${e.words}”` : `“${e.old}” → “${e.new}”`;
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<section
	class="transcript-pane"
	data-testid="transcript-pane"
	tabindex="0"
	bind:this={box}
	onkeydown={onKeydown}
	aria-label="Transcript"
>
	{#if model.loading}
		<p class="note">Loading…</p>
	{:else if !model.transcript}
		<div class="empty">
			<p class="note">No transcript yet.</p>
			<button disabled={model.transcribing !== null} onclick={() => void model.transcribe()}
				>{model.transcribing ? `Transcribing… ${model.transcribing}` : 'Transcribe'}</button
			>
		</div>
	{:else}
		{#if model.staleEdits}
			<div class="stale" title="The transcript changed since these edits were made.">
				<span>{model.staleEdits.edits.length} edits from an older transcript.</span>
				<button onclick={() => model.discardStale()}>Discard</button>
			</div>
		{/if}
		<div class="words">
			{#each model.words as w, i (i)}
				<button
					type="button"
					class="word {classOf(i)}"
					title={clock(w.start)}
					onclick={(e) => clickWord(i, e)}>{w.text}</button
				>
			{/each}
		</div>
		{#if replacing}
			<form
				class="replace"
				onsubmit={(e) => {
					e.preventDefault();
					doReplace();
				}}
			>
				<input
					bind:this={field}
					bind:value={replaceText}
					placeholder="Say instead…"
					aria-label="Replacement words"
					onkeydown={(e) => {
						if (e.key === 'Escape') replacing = false;
					}}
				/>
				<button type="submit" disabled={!replaceText.trim()}>Replace</button>
			</form>
		{/if}
		{#if model.edits?.edits.length}
			<ul class="chips">
				{#each model.edits.edits as e (e.id)}
					<li class={e.kind}>
						<button class="link" onclick={() => onseek(e.from)}>{clock(e.from)}</button>
						<span>{chipText(e)}</span>
						<button onclick={() => model.undo(e.id)}>Undo</button>
					</li>
				{/each}
			</ul>
		{/if}
		<div class="bar">
			<button disabled={!model.selection} onclick={() => model.cut()}>Cut</button>
			<button disabled={!model.selection} onclick={() => void openReplace()}>Replace…</button>
			<label title="The saved voice replacements speak in (Settings → Audio → Saved voices)">
				Voice:
				<select
					value={model.edits?.voice ?? ''}
					onchange={(e) => model.setVoice(e.currentTarget.value)}
				>
					<option value="">None</option>
					{#each voices as v (v.id)}
						<option value={v.name}>{v.name}</option>
					{/each}
				</select>
			</label>
			<span class="spacer"></span>
			<button disabled={!model.dirty || !!model.staleEdits} onclick={() => void save()}>Save</button
			>
			<button
				disabled={!model.edits?.edits.length || !!model.staleEdits}
				title="Saves, then puts /fix-speech apply in this folder's chat"
				onclick={() => void send()}>Send to chat</button
			>
		</div>
	{/if}
	{#if model.error}<p class="note error">{model.error}</p>{/if}
	{#if note}<p class="note">{note}</p>{/if}
</section>

<style>
	.transcript-pane {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-height: 0;
		min-width: 0;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		outline: none;
	}
	.transcript-pane:focus-visible {
		border-color: var(--accent);
	}
	.words {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		line-height: 1.9;
		font-size: 0.95rem;
	}
	.word {
		all: unset;
		cursor: pointer;
		border-radius: 3px;
		padding: 0 1px;
		margin-right: 0.25em;
	}
	.word:hover {
		background: color-mix(in srgb, var(--text-primary) 10%, transparent);
	}
	.word.current {
		background: color-mix(in srgb, var(--accent) 35%, transparent);
	}
	.word.selected {
		outline: 2px solid var(--accent);
	}
	.word.cut {
		text-decoration: line-through;
		color: var(--text-secondary);
	}
	.word.replaced {
		text-decoration: underline wavy var(--accent);
	}
	.stale {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.85rem;
		color: var(--text-secondary);
		opacity: 0.8;
	}
	.replace {
		display: flex;
		gap: 6px;
	}
	.replace input {
		flex: 1;
		min-width: 0;
	}
	.chips {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 8rem;
		overflow-y: auto;
		font-size: 0.85rem;
	}
	.chips li {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.chips span {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.link {
		all: unset;
		cursor: pointer;
		color: var(--accent);
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		font-size: 0.85rem;
	}
	.spacer {
		flex: 1;
	}
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 16px;
	}
	.note {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}
	.note.error {
		color: var(--danger, #ef4444);
	}
</style>
