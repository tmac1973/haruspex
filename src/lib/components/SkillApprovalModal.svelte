<script lang="ts">
	/**
	 * Asks before `create_skill`, `update_skill` or `write_agents_md` writes
	 * anything. Mounted in the root layout; see `stores/skillApproval.svelte.ts`
	 * for why every write is asked about.
	 *
	 * Shows the whole file in the editor, so the user approves what they
	 * can read and may change it first. Saving happens here: if the edited text
	 * can't be saved, the error shows and the prompt stays open.
	 *
	 * Backdrop and Esc don't dismiss: the turn is waiting on the answer.
	 */
	import Modal from './Modal.svelte';
	import ModalButton from './ModalButton.svelte';
	import CodeEditor from './CodeEditor.svelte';
	import {
		getPendingSkillApproval,
		resolveSkillApproval
	} from '#lib/stores/skillApproval.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	const pending = $derived(getPendingSkillApproval());
	const agentsMd = $derived(pending?.kind === 'agentsMd');
	const file = $derived(agentsMd ? 'AGENTS.md' : 'SKILL.md');

	let text = $state('');
	let reason = $state('');
	let error = $state('');
	let saving = $state(false);
	let showCurrent = $state(false);
	let loadedFor: unknown = null;
	const lines = $derived(text.trimEnd().split('\n').length);

	$effect(() => {
		if (pending && loadedFor !== pending) {
			loadedFor = pending;
			text = pending.text;
			reason = '';
			error = '';
			saving = false;
			showCurrent = false;
		}
	});

	async function save() {
		if (!pending || saving) return;
		saving = true;
		error = '';
		try {
			await pending.save(text);
			resolveSkillApproval({ kind: 'saved', edited: text !== pending.text });
		} catch (e) {
			error = errMessage(e);
		} finally {
			saving = false;
		}
	}
</script>

<Modal open={pending != null} maxWidth={760} labelledBy="skill-approval-title">
	{#if pending}
		{#if agentsMd}
			<h2 id="skill-approval-title">
				{pending.update ? "Change this repo's AGENTS.md?" : 'Add an AGENTS.md to this repo?'}
			</h2>
			<p>
				Every coding turn in this repo reads it, here and in other agents. Edit it here first if you
				like.
			</p>
			<p class="dir">{pending.dir} <span class="count">· {lines} lines</span></p>
		{:else}
			<h2 id="skill-approval-title">
				{pending.update ? 'Change' : 'Save'} the "{pending.name}" skill?
			</h2>
			<p>
				It will be {pending.update ? 'changed' : 'saved'}
				{pending.project ? 'in this repo, for anyone who works on it' : 'in your skills'}, and can
				steer later conversations. Edit it here first if you like.
			</p>
			<p class="dir">{pending.dir}</p>
		{/if}
		{#if pending.current !== null}
			<button class="link" onclick={() => (showCurrent = !showCurrent)}>
				{showCurrent ? 'Show the new version' : 'Show the current version'}
			</button>
		{/if}
		<div class="editor">
			{#if showCurrent && pending.current !== null}
				<pre class="current" aria-label="Current {file}">{pending.current}</pre>
			{:else}
				<CodeEditor value={text} onchange={(v) => (text = v)} onsave={save} label={file} />
			{/if}
		</div>
		{#if error}
			<p class="error" role="alert">Not saved: {error}</p>
		{/if}
		<label class="reason">
			<span>Reason, if you reject it</span>
			<input type="text" bind:value={reason} placeholder="Sent to the model" />
		</label>
		<div class="button-row">
			<ModalButton onclick={save}>
				{#snippet title()}{pending.update
						? 'Save changes'
						: agentsMd
							? 'Save AGENTS.md'
							: 'Save skill'}{/snippet}
				{#snippet subtitle()}{agentsMd
						? 'Read from the next turn'
						: `Run it with /${pending.name}`}{/snippet}
			</ModalButton>
			<ModalButton
				variant="danger"
				onclick={() => !saving && resolveSkillApproval({ kind: 'rejected', reason })}
			>
				{#snippet title()}Reject{/snippet}
				{#snippet subtitle()}Nothing is written; the model is told why{/snippet}
			</ModalButton>
		</div>
		{#if !agentsMd}
			<p class="help">Settings → Skills lists and deletes skills.</p>
		{/if}
	{/if}
</Modal>

<style>
	.dir {
		margin: 0.5rem 0;
		padding: 0.5rem 0.75rem;
		border-left: 3px solid var(--accent);
		background: var(--bg-secondary);
		border-radius: 0 6px 6px 0;
		font-family: monospace;
		font-size: 0.85rem;
		word-break: break-all;
	}

	.count {
		color: var(--text-secondary);
		font-family: inherit;
	}

	.link {
		padding: 0;
		border: none;
		background: none;
		color: var(--accent);
		font-size: 0.85rem;
		cursor: pointer;
	}

	.editor {
		height: 320px;
		margin: 0.5rem 0;
	}

	.current {
		height: 100%;
		margin: 0;
		padding: 0.5rem 0.75rem;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		font-size: 0.85rem;
		white-space: pre-wrap;
	}

	.error {
		color: var(--danger, #ef4444);
		font-size: 0.85rem;
	}

	.reason {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.reason input {
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	.button-row {
		display: flex;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.button-row > :global(*) {
		flex: 1;
	}

	.help {
		margin: 1rem 0 0 0;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}
</style>
