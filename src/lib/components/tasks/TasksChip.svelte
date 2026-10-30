<script lang="ts">
	/**
	 * "Tasks: N" at the right of the tab bar, from every tab: the background
	 * tasks running anywhere in the app, and the background processes and
	 * subtasks of the Code sessions open in this window. Clicking lists them,
	 * with Cancel or Stop and a link to the chat or session each belongs to.
	 * It stays for a while after the last one ends, so a result can be found
	 * again.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { setActiveTab } from '#lib/stores/activeTab.svelte.ts';
	import { getConversations, setActiveConversation } from '#lib/stores/chat.svelte.ts';
	import { getAllBackgroundWork, getOpenSessions, openSession } from '#lib/stores/code.svelte.ts';
	import { listCodeSessions } from '#lib/code/db.ts';
	import { sessionLabel } from '#lib/code/sessionList.ts';
	import { getTasks } from '#lib/tasks/store.svelte.ts';
	import { progressLine } from '#lib/tasks/progress.ts';
	import { hasEnded, type BackgroundTask } from '#lib/tasks/types.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { getSettings } from '#lib/stores/settings.ts';
	import { errMessage } from '#lib/utils/error.ts';

	/** How long the chip, and a finished task's row, stay after it ends. */
	const LINGER_MS = 10 * 60 * 1000;

	let now = $state(Date.now());
	let open = $state(false);
	let root = $state<HTMLElement | null>(null);
	/** Code session names, read when the list opens: a session needn't be open to own a task. */
	let codeNames = $state<Record<string, string>>({});

	onMount(() => {
		const tick = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(tick);
	});

	const tasks = $derived(getTasks());
	const running = $derived(tasks.filter((t) => !hasEnded(t.state)));
	const recent = $derived(
		tasks.filter((t) => hasEnded(t.state) && now - (t.endedMs ?? t.startedMs) < LINGER_MS).reverse()
	);
	const work = $derived(getAllBackgroundWork());
	const count = $derived(running.length + work.length);
	const visible = $derived(count > 0 || recent.length > 0);

	function ownerName(owner: string): string {
		const [kind, id] = [owner.slice(0, owner.indexOf(':')), owner.slice(owner.indexOf(':') + 1)];
		if (kind === 'chat') return getConversations().find((c) => c.id === id)?.title ?? 'A chat';
		const live = getOpenSessions().find((s) => s.id === id);
		return live ? sessionLabel(live) : (codeNames[id] ?? 'A Code session');
	}

	const tooltip = $derived(
		[
			...running.map((t) => `${t.label} (${ownerName(t.owner)})`),
			...work.map((w) => `${w.label} (${ownerName(`code:${w.sessionId}`)})`)
		].join('\n') || 'Background tasks that finished in the last few minutes'
	);

	async function toggle() {
		open = !open;
		if (!open) return;
		now = Date.now();
		try {
			const list = await listCodeSessions();
			codeNames = Object.fromEntries(list.map((s) => [s.id, sessionLabel(s)]));
		} catch {
			// Names fall back to "A Code session".
		}
	}

	async function goTo(owner: string) {
		open = false;
		const id = owner.slice(owner.indexOf(':') + 1);
		try {
			if (owner.startsWith('chat:')) {
				setActiveTab('chat');
				await setActiveConversation(id);
			} else if (getSettings().leanMode) {
				// Lean mode hides the Code tab; the task is still listed here.
				showToast('Turn off lean mode in Settings → General to open the Code tab.');
			} else {
				setActiveTab('code');
				await openSession(id);
			}
		} catch (e) {
			showToast(`Couldn't open it: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	async function cancel(t: BackgroundTask) {
		try {
			await invoke('task_cancel', { id: t.id });
		} catch (e) {
			showToast(`Couldn't cancel it: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	function onWindowClick(e: MouseEvent) {
		if (open && root && !root.contains(e.target as Node)) open = false;
	}

	function onKeydown(e: KeyboardEvent) {
		if (open && e.key === 'Escape') open = false;
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onKeydown} />

{#if visible}
	<div class="tasks" bind:this={root}>
		<button
			class="chip"
			type="button"
			title={tooltip}
			aria-expanded={open}
			onclick={() => void toggle()}
		>
			{count > 0 ? `Tasks: ${count}` : 'Tasks'}
		</button>
		{#if open}
			<div class="list" role="dialog" aria-label="Background tasks">
				{#each running as t (t.id)}
					<div class="row">
						<div class="what">
							<span class="label">{t.label}</span>
							<button class="owner" type="button" onclick={() => void goTo(t.owner)}
								>{ownerName(t.owner)}</button
							>
						</div>
						<span class="detail">{progressLine(t)}</span>
						<button class="btn" type="button" onclick={() => void cancel(t)}>Cancel</button>
					</div>
				{/each}
				{#each work as w (w.id)}
					<div class="row">
						<div class="what">
							<span class="label" title={w.label}>{w.label}</span>
							<button class="owner" type="button" onclick={() => void goTo(`code:${w.sessionId}`)}
								>{ownerName(`code:${w.sessionId}`)}</button
							>
						</div>
						<span class="detail">{w.kind === 'process' ? 'Command' : 'Subtask'}</span>
						<button class="btn" type="button" onclick={w.stop}>Stop</button>
					</div>
				{/each}
				{#if recent.length}
					<div class="heading">Done</div>
					{#each recent as t (t.id)}
						<div class="row">
							<div class="what">
								<span class="label">{t.label}</span>
								<button class="owner" type="button" onclick={() => void goTo(t.owner)}
									>{ownerName(t.owner)}</button
								>
							</div>
							<span class="detail" class:bad={t.state === 'failed'}
								>{t.state === 'done' ? 'Done' : t.state === 'failed' ? 'Failed' : 'Cancelled'}</span
							>
						</div>
					{/each}
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.tasks {
		position: relative;
		display: flex;
		align-items: center;
		margin-left: auto;
		padding-right: 10px;
	}

	.chip {
		appearance: none;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--bg-secondary, transparent);
		color: var(--text-primary);
		font-size: 0.75rem;
		font-weight: 600;
		padding: 2px 10px;
		cursor: pointer;
	}

	.chip:hover {
		border-color: var(--accent);
	}

	.list {
		position: absolute;
		top: calc(100% + 4px);
		right: 10px;
		z-index: 50;
		width: min(420px, 90vw);
		max-height: 60vh;
		overflow: auto;
		padding: 6px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-primary);
		box-shadow: 0 6px 20px rgb(0 0 0 / 18%);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px;
		border-radius: 6px;
	}

	.row:hover {
		background: var(--bg-secondary, transparent);
	}

	.what {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}

	.label {
		font-size: 0.85rem;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.owner {
		appearance: none;
		border: none;
		background: none;
		padding: 0;
		text-align: left;
		font-size: 0.75rem;
		color: var(--accent);
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.owner:hover {
		text-decoration: underline;
	}

	.detail {
		flex-shrink: 0;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.bad {
		color: var(--error, #c33);
	}

	.heading {
		padding: 8px 6px 2px;
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-secondary);
	}
</style>
