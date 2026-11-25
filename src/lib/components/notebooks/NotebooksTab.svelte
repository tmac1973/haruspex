<script lang="ts">
	/**
	 * The Notebooks tab: the notebook list on the left, the open notebook (or
	 * Trash) in the middle, and the notebook's agent chat on the right.
	 */
	import { onMount } from 'svelte';
	import NotebookList from '#lib/components/notebooks/NotebookList.svelte';
	import NotebookView from '#lib/components/notebooks/NotebookView.svelte';
	import TrashView from '#lib/components/notebooks/TrashView.svelte';
	import SourceBadge from '#lib/components/notebooks/SourceBadge.svelte';
	import CardHistory from '#lib/components/notebooks/CardHistory.svelte';
	import NotebookChatPanel from '#lib/components/notebooks/NotebookChatPanel.svelte';
	import PeerNotebooks from '#lib/components/notebooks/PeerNotebooks.svelte';
	import { PeerNotebookChat } from '#lib/notebooks/backend.svelte.ts';
	import { peerView } from '#lib/peers/store.svelte.ts';
	import { persistItem } from '#lib/persist.ts';
	import type { NotebookCard } from '#lib/notebooks/api.ts';
	import { pickFilesAsCards } from '#lib/notebooks/files.ts';
	import { exportNotebook, exportTable, type NotebookFormat } from '#lib/notebooks/export.ts';
	import { importFiles } from '#lib/notebooks/import.ts';
	import { emailNotebook, fileOnGitHub, printNotebook } from '#lib/notebooks/share.ts';
	import { githubReady } from '#lib/github/issues.ts';
	import { canEmail } from '#lib/share/email.ts';
	import { getLiveSettings } from '#lib/stores/settings.ts';
	import {
		emitNotebookChanged,
		openNotebook,
		checkOpenLinks,
		getLinkStatuses,
		isCheckingLinks,
		getOpenBackend,
		getOpenNotebook,
		isNotebookListLoaded,
		isTrashShown,
		loadNotebookList
	} from '#lib/stores/notebooks.svelte.ts';

	onMount(() => {
		if (!isNotebookListLoaded()) void loadNotebookList();
	});

	const open = $derived(getOpenNotebook());

	const CHAT_KEY = 'haruspex.notebookChatOpen';
	function chatOpenAtStart(): boolean {
		try {
			return localStorage.getItem(CHAT_KEY) !== 'false';
		} catch {
			return true;
		}
	}
	let chatOpen = $state(chatOpenAtStart());
	function setChatOpen(open: boolean) {
		chatOpen = open;
		try {
			persistItem(CHAT_KEY, String(open));
		} catch {
			// a convenience only
		}
	}

	const EXPORTS: [NotebookFormat, string][] = [
		['pdf', 'PDF'],
		['docx', 'Word'],
		['odt', 'OpenDocument'],
		['html', 'web page'],
		['markdown', 'Markdown'],
		['ipynb', 'Jupyter notebook']
	];

	/** Print, and Email when an account can send. */
	function shareItems(id: string, card?: NotebookCard) {
		const what = card ? ' card' : '';
		const items = [{ label: `Print${what}…`, run: () => void printNotebook(id, card) }];
		if (canEmail(getLiveSettings())) {
			items.push({ label: `Email${what}…`, run: () => void emailNotebook(id, card) });
		}
		if (githubReady()) {
			items.push(
				{
					label: `File${what} as GitHub issue…`,
					run: () => void fileOnGitHub(id, card, 'issue')
				},
				{
					label: `Add${what} to a GitHub issue…`,
					run: () => void fileOnGitHub(id, card, 'comment')
				}
			);
		}
		return items;
	}

	function notebookMenu(id: string) {
		return [
			...shareItems(id),
			...EXPORTS.map(([format, name]) => ({
				label: `Export as ${name}…`,
				run: () => void exportNotebook(id, format)
			})),
			{
				label: isCheckingLinks() ? 'Checking links…' : 'Check links',
				run: () => void checkOpenLinks()
			},
			{
				label: 'Refresh on a schedule…',
				run: () =>
					void import('#lib/agent/jobs/openDraft.ts').then(({ openJobDraft }) =>
						openJobDraft({
							jobType: 'notebook_refresh',
							name: `Refresh ${open?.notebook.title ?? 'notebook'}`,
							workingDir: '',
							config: { notebookId: id, instruction: '' }
						})
					)
			},
			{
				label: 'Import into this notebook…',
				run: () =>
					void importFiles(id).then((done) => {
						if (done) emitNotebookChanged(done);
					})
			}
		];
	}

	function cardMenu(card: NotebookCard) {
		const items: { label: string; run: () => void }[] = [
			{
				label: 'History…',
				run: () => {
					historyFor = card;
				}
			}
		];
		if (getOpenBackend().kind === 'local' && open) {
			items.push(...shareItems(open.notebook.id, card));
		}
		if (card.kind === 'table' && getOpenBackend().kind === 'local') {
			items.push(
				{ label: 'Export table as CSV…', run: () => void exportTable(card, 'csv') },
				{ label: 'Export table as Excel…', run: () => void exportTable(card, 'xlsx') }
			);
		}
		return items;
	}

	async function importNew() {
		const id = await importFiles(null);
		if (id) {
			await loadNotebookList();
			await openNotebook(id);
		}
	}

	const brokenCount = $derived(
		Object.values(getLinkStatuses()).filter((l) => l.state === 'broken').length
	);

	function showFirstBroken() {
		document
			.querySelector('.notebooks .link-broken')
			?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}

	/** The open notebook's chat when it's on another computer. */
	let peerChat = $state<PeerNotebookChat | null>(null);
	$effect(() => {
		const be = getOpenBackend();
		const id = open?.notebook.id;
		const client = be.peerId ? peerView(be.peerId)?.client : undefined;
		if (!client || !id) {
			peerChat = null;
			return;
		}
		const chat = new PeerNotebookChat(client, id);
		peerChat = chat;
		return () => chat.dispose();
	});

	/** The card whose History is showing. */
	let historyFor = $state<NotebookCard | null>(null);
</script>

<div class="notebooks">
	<NotebookList onimport={() => void importNew()}>
		{#snippet more()}
			<PeerNotebooks />
		{/snippet}
	</NotebookList>
	{#if isTrashShown()}
		<TrashView />
	{:else if open}
		<NotebookView
			notebook={open}
			onpickkind={(kind, after) => {
				if (kind === 'image' || kind === 'attachment') void pickFilesAsCards(kind, after);
			}}
			{cardMenu}
			banner={brokenCount > 0 ? brokenBanner : undefined}
			menuItems={getOpenBackend().kind === 'local' ? notebookMenu(open.notebook.id) : []}
		>
			{#snippet cardBadge(card)}
				<SourceBadge {card} />
			{/snippet}
		</NotebookView>
		{#if chatOpen}
			<NotebookChatPanel
				notebookId={open.notebook.id}
				title={open.notebook.title}
				peer={peerChat}
				onclose={() => setChatOpen(false)}
			/>
		{:else}
			<button class="chat-tab" onclick={() => setChatOpen(true)} title="Ask about this notebook">
				«&nbsp;Ask
			</button>
		{/if}
	{:else}
		<div class="none">
			<p>Pick a notebook, or make one with + New.</p>
		</div>
	{/if}
</div>
{#snippet brokenBanner()}
	<button class="broken-banner" onclick={showFirstBroken} title="Show the first one">
		⚠ {brokenCount} broken {brokenCount === 1 ? 'link' : 'links'}
	</button>
{/snippet}
{#if historyFor}
	<CardHistory card={historyFor} onclose={() => (historyFor = null)} />
{/if}

<style>
	.notebooks {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}

	.chat-tab {
		align-self: flex-start;
		margin: 12px 8px 0 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		color: var(--text-secondary);
		cursor: pointer;
		padding: 4px 8px;
		font-size: 0.8rem;
	}

	.none {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
	}

	.broken-banner {
		display: block;
		margin: 0 0 8px;
		border: 1px solid var(--warning);
		border-radius: 6px;
		background: none;
		color: var(--warning);
		cursor: pointer;
		padding: 4px 10px;
		font-size: 0.85rem;
	}
</style>
