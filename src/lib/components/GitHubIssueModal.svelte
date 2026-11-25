<script lang="ts">
	/**
	 * File on GitHub: a notebook or card as a new issue, or as a comment on
	 * one (`stores/githubIssue.svelte.ts`). Mounted once in the root layout.
	 * Everything is editable; nothing reaches GitHub until Create issue or
	 * Add comment, and an error keeps the dialog open with the text intact.
	 */
	import { untrack } from 'svelte';
	import Modal from '#lib/components/Modal.svelte';
	import { closeGitHubFile, getGitHubFile } from '#lib/stores/githubIssue.svelte.ts';
	import {
		commentOn,
		createIssue,
		issueTitle,
		MAX_BODY_CHARS,
		myRepos,
		parseIssue,
		parseRepo,
		recentRepos,
		repoLabels,
		type RepoRef
	} from '#lib/github/issues.ts';
	import { markdownHtml } from '#lib/notebooks/export.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { openInBrowser } from '#lib/utils/openInBrowser.ts';
	import { errMessage } from '#lib/utils/error.ts';

	const request = $derived(getGitHubFile());

	let mode = $state<'issue' | 'comment'>('issue');
	let repoText = $state('');
	let issueText = $state('');
	let title = $state('');
	let labelsText = $state('');
	let body = $state('');
	let preview = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let repos = $state<string[]>([]);
	let available = $state<string[]>([]);
	let target = $state<{ key: string; title: string } | null>(null);

	// Load each request into the fields, and the repositories to suggest.
	$effect(() => {
		const r = request;
		if (!r) return;
		untrack(() => {
			mode = r.mode;
			title = r.title;
			body = r.body;
			const recent = recentRepos();
			repoText = recent[0] ?? '';
			repos = recent;
			issueText = '';
			labelsText = '';
			preview = false;
			busy = false;
			error = null;
			target = null;
		});
		void myRepos()
			.then((mine) => {
				const seen = new Set(repos.map((x) => x.toLowerCase()));
				repos = [...repos, ...mine.filter((x) => !seen.has(x.toLowerCase()))];
			})
			.catch((e: unknown) => console.warn('github: repositories not listed', e));
	});

	const issue = $derived(parseIssue(issueText));
	/** The repository: an issue URL names its own, else the field's. */
	const repo = $derived<RepoRef | null>(issue?.repo ?? parseRepo(repoText));
	const repoKey = $derived(repo ? `${repo.owner}/${repo.repo}` : '');
	const labels = $derived(
		labelsText
			.split(',')
			.map((l) => l.trim())
			.filter(Boolean)
	);
	const tooLong = $derived(body.length > MAX_BODY_CHARS);
	const ready = $derived(
		!!repo &&
			body.trim() !== '' &&
			!tooLong &&
			!busy &&
			(mode === 'issue' ? title.trim() !== '' : !!issue)
	);

	// The chosen repository's labels, for a new issue.
	$effect(() => {
		const r = repo;
		const key = repoKey;
		if (!r || mode !== 'issue') return;
		const timer = setTimeout(() => {
			void repoLabels(r)
				.then((names) => {
					if (key === repoKey) available = names;
				})
				.catch(() => (available = []));
		}, 400);
		return () => clearTimeout(timer);
	});

	// The issue a comment goes on, by title, so a wrong number shows.
	$effect(() => {
		const r = repo;
		const n = issue?.number;
		if (!r || !n || mode !== 'comment') return;
		const key = `${r.owner}/${r.repo}#${n}`;
		const timer = setTimeout(() => {
			void issueTitle(r, n)
				.then((t) => (target = { key, title: t }))
				.catch(() => (target = { key, title: '' }));
		}, 400);
		return () => clearTimeout(timer);
	});
	const targetTitle = $derived(
		target && issue && repo && target.key === `${repoKey}#${issue.number}` ? target.title : null
	);

	function toggleLabel(name: string) {
		const has = labels.some((l) => l.toLowerCase() === name.toLowerCase());
		const next = has
			? labels.filter((l) => l.toLowerCase() !== name.toLowerCase())
			: [...labels, name];
		labelsText = next.join(', ');
	}

	async function submit() {
		if (!ready || !repo) return;
		busy = true;
		error = null;
		try {
			const link =
				mode === 'issue'
					? await createIssue(repo, title, body, labels)
					: await commentOn(repo, issue!.number, body);
			closeGitHubFile();
			showToast(
				mode === 'issue'
					? `Opened an issue in ${repoKey}.`
					: `Commented on ${repoKey}#${issue!.number}.`,
				{
					kind: 'success',
					actionLabel: 'Open',
					onAction: () => void openInBrowser(link)
				}
			);
		} catch (e) {
			error = errMessage(e);
		} finally {
			busy = false;
		}
	}

	function cancel() {
		if (!busy) closeGitHubFile();
	}
</script>

<Modal
	open={request != null}
	maxWidth={720}
	title="File on GitHub"
	dismissable
	onclose={cancel}
	labelledBy="github-file-title"
>
	{#if request}
		<div class="form">
			<div class="modes" role="radiogroup" aria-label="File as">
				<label class="mode">
					<input type="radio" bind:group={mode} value="issue" disabled={busy} /> New issue
				</label>
				<label class="mode">
					<input type="radio" bind:group={mode} value="comment" disabled={busy} /> Comment on an issue
				</label>
			</div>
			<label>
				<span>Repository</span>
				<input
					type="text"
					bind:value={repoText}
					list="github-file-repos"
					placeholder="owner/name"
					disabled={busy || !!issue?.repo}
					title={issue?.repo ? 'Taken from the issue link.' : undefined}
				/>
			</label>
			<datalist id="github-file-repos">
				{#each repos as r (r)}<option value={r}></option>{/each}
			</datalist>
			{#if repoText.trim() && !repo}
				<p class="error-text">Write the repository as owner/name.</p>
			{/if}
			{#if mode === 'comment'}
				<label>
					<span>Issue</span>
					<input
						type="text"
						bind:value={issueText}
						placeholder="123, or its link"
						disabled={busy}
					/>
				</label>
				{#if targetTitle !== null}
					<p class="hint">{targetTitle || 'No such issue in this repository.'}</p>
				{/if}
			{:else}
				<label>
					<span>Title</span>
					<input type="text" bind:value={title} disabled={busy} />
				</label>
				<label>
					<span>Labels</span>
					<input
						type="text"
						bind:value={labelsText}
						placeholder="Optional, comma-separated"
						disabled={busy}
					/>
				</label>
				{#if available.length}
					<div class="labels" aria-label="Labels in this repository">
						{#each available.slice(0, 24) as l (l)}
							<button
								type="button"
								class="chip"
								class:on={labels.some((x) => x.toLowerCase() === l.toLowerCase())}
								aria-pressed={labels.some((x) => x.toLowerCase() === l.toLowerCase())}
								onclick={() => toggleLabel(l)}
								disabled={busy}
							>
								{l}
							</button>
						{/each}
					</div>
				{/if}
			{/if}
			{#if preview}
				<div class="preview markdown" aria-label="Preview">
					<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised by markdownHtml -->
					{@html markdownHtml(body)}
				</div>
			{:else}
				<textarea bind:value={body} rows="12" aria-label="Body" disabled={busy}></textarea>
			{/if}
			<div class="body-tools">
				<button type="button" class="link-btn" onclick={() => (preview = !preview)}>
					{preview ? 'Edit' : 'Preview'}
				</button>
				<span
					class="hint"
					class:error-text={tooLong}
					title="Pictures and files are named in the text; GitHub's API can't upload them."
				>
					{tooLong
						? `${body.length.toLocaleString()} characters, over GitHub's ${MAX_BODY_CHARS.toLocaleString()}.`
						: 'Markdown'}
				</span>
			</div>
			{#if error}
				<p class="error-text">{error}</p>
			{/if}
			<div class="actions">
				<button type="button" class="btn" onclick={cancel} disabled={busy}>Cancel</button>
				<button type="button" class="btn btn-primary" onclick={submit} disabled={!ready}>
					{busy ? 'Sending…' : mode === 'issue' ? 'Create issue' : 'Add comment'}
				</button>
			</div>
		</div>
	{/if}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	label {
		display: grid;
		grid-template-columns: 5.5rem 1fr;
		align-items: center;
		gap: 0.5rem;
	}

	label span {
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.modes {
		display: flex;
		gap: 1rem;
	}

	label.mode {
		display: inline-flex;
		gap: 0.3rem;
		font-size: 0.9rem;
	}

	textarea {
		width: 100%;
		resize: vertical;
		font: inherit;
	}

	.preview {
		max-height: 24rem;
		overflow: auto;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
	}

	.labels {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin-left: 6rem;
	}

	.chip {
		border: 1px solid var(--border);
		border-radius: 12px;
		background: none;
		color: var(--text-secondary);
		font-size: 0.8rem;
		padding: 1px 8px;
		cursor: pointer;
	}

	.chip.on {
		border-color: var(--accent);
		color: var(--text-primary);
	}

	.body-tools {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.85rem;
	}

	.link-btn {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		cursor: pointer;
		font: inherit;
	}

	.hint {
		color: var(--text-secondary);
		font-size: 0.85rem;
		margin: 0 0 0 6rem;
	}

	.body-tools .hint {
		margin: 0;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
