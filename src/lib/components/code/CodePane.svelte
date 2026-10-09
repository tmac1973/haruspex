<script lang="ts">
	/**
	 * One open Code session: its header, transcript and input box, and a
	 * banner when its folder is gone. The folder is looked at again whenever
	 * the window gains focus (the user may have been in a file manager).
	 */
	import CodeSessionHeader from './CodeSessionHeader.svelte';
	import FolderMissingBanner from './FolderMissingBanner.svelte';
	import CodeTranscript from './CodeTranscript.svelte';
	import CodeComposer from './CodeComposer.svelte';
	import type { SlashHost } from '#lib/slash/slash.ts';
	import type { TranscriptNote } from './CodeTranscript.svelte';
	import { shellProject } from '#lib/skills/project.ts';
	import type { CodeSession } from '#lib/stores/code.svelte.ts';
	import { newSessionBeside } from '#lib/code/windows.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let {
		session,
		ondeleted
	}: {
		session: CodeSession;
		/** After the banner deletes the session. */
		ondeleted?: () => void;
	} = $props();

	/**
	 * Notes `/skills` and friends put in the transcript; not saved. Each keeps
	 * the thread length it was added at, so it stays where it was typed instead
	 * of below everything that came after it.
	 */
	let notes = $state<TranscriptNote[]>([]);

	const slashHost: SlashHost = {
		projectRoot: async () => session.projectRoot ?? (await shellProject(session.root)).root,
		codeMode: () => true,
		// `/new` here is a new session in the same folder.
		newConversation: () => {
			newSessionBeside(session).catch((e: unknown) =>
				showToast(`Couldn't start a session: ${errMessage(e)}`, { kind: 'error' })
			);
		},
		addNote: (text) => (notes = [...notes, { text, at: session.messages.length }])
	};
</script>

<svelte:window onfocus={() => void session.checkFolder()} />

<div class="pane">
	<CodeSessionHeader {session} />
	{#if session.folderMissing}
		<FolderMissingBanner {session} {ondeleted} />
	{/if}
	<CodeTranscript {session} {notes} />
	<CodeComposer {session} {slashHost} />
</div>

<style>
	.pane {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		background: var(--bg-chat);
	}
</style>
