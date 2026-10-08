<script lang="ts">
	/** One open Code session: its header, transcript and input box. */
	import CodeSessionHeader from './CodeSessionHeader.svelte';
	import CodeTranscript from './CodeTranscript.svelte';
	import CodeComposer from './CodeComposer.svelte';
	import type { SlashHost } from '#lib/slash/slash.ts';
	import { shellProject } from '#lib/skills/project.ts';
	import { newSession, type CodeSession } from '#lib/stores/code.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { session }: { session: CodeSession } = $props();

	/** Notes `/skills` and friends put in the transcript; not saved. */
	let notes = $state<string[]>([]);

	const slashHost: SlashHost = {
		projectRoot: async () => session.projectRoot ?? (await shellProject(session.root)).root,
		codeMode: () => true,
		// `/new` here is a new session in the same folder.
		newConversation: () => {
			newSession(session.root).catch((e: unknown) =>
				showToast(`Couldn't start a session: ${errMessage(e)}`, { kind: 'error' })
			);
		},
		addNote: (text) => (notes = [...notes, text])
	};
</script>

<div class="pane">
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
