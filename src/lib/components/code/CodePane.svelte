<script lang="ts">
	/** One open Code session: its header, transcript and input box. */
	import CodeSessionHeader from './CodeSessionHeader.svelte';
	import CodeTranscript from './CodeTranscript.svelte';
	import CodeComposer from './CodeComposer.svelte';
	import type { SlashHost } from '#lib/slash/slash.ts';
	import type { TranscriptNote } from './CodeTranscript.svelte';
	import { shellProject } from '#lib/skills/project.ts';
	import { newSession, type CodeSession } from '#lib/stores/code.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { session }: { session: CodeSession } = $props();

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
			newSession(session.root).catch((e: unknown) =>
				showToast(`Couldn't start a session: ${errMessage(e)}`, { kind: 'error' })
			);
		},
		addNote: (text) => (notes = [...notes, { text, at: session.messages.length }])
	};
</script>

<!-- data-status: what scripts/drive.mjs waits on (idle, queued, running, waiting-shell). -->
<div class="pane" data-session-id={session.id} data-status={session.status}>
	<CodeSessionHeader {session} />
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
