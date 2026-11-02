/**
 * Work on this, on a GitHub card's issue: in the user's own checkout of the
 * repo, either a new Code session with the issue as an unsent first message,
 * or a new guided-planning job filled in from it, unsaved. The checkout is
 * the newest saved Code session whose folder's `origin` is the repo.
 */
import { invoke } from '@tauri-apps/api/core';
import { listCodeSessions } from '#lib/code/db.ts';
import { getJobType } from '#lib/agent/jobs/types/index.ts';
import { readIssueBody, type GitHubItem } from '#lib/home/github.ts';
import { setActiveTab } from '#lib/stores/activeTab.svelte.ts';
import { openCodeSessionAt } from '#lib/stores/code.svelte.ts';
import { newJobDraft } from '#lib/stores/jobsTabSelection.svelte.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';

/** The newest saved Code session's folder that is a checkout of `repo`, or null. */
async function checkoutOf(repo: string): Promise<string | null> {
	const saved = await listCodeSessions();
	// Host folders only: a WSL session's root is a path inside its distro.
	const roots = [
		...new Set(
			saved
				.filter((s) => !s.wsl_distro)
				.sort((a, b) => b.updated_at - a.updated_at)
				.map((s) => s.root)
		)
	];
	return invoke<string | null>('code_checkout_find', { repo, roots });
}

/** The checkout and the issue's body, or null after telling the user why not. */
async function prepare(item: GitHubItem): Promise<{ root: string; body: string } | null> {
	const root = await checkoutOf(item.repo);
	if (!root) {
		showToast(`No local checkout of ${item.repo} found. Open it once in the Code tab.`, {
			kind: 'error'
		});
		return null;
	}
	try {
		return { root, body: await readIssueBody(item.repo, item.number) };
	} catch {
		showToast(`Couldn't read ${item.repo}#${item.number} from GitHub.`, { kind: 'error' });
		return null;
	}
}

function issueText(item: GitHubItem, body: string): string {
	return [item.title, body.trim(), item.url].filter(Boolean).join('\n\n');
}

/** A new Code session in the checkout, with the issue in its input box, unsent. */
export async function openSessionOnIssue(item: GitHubItem): Promise<void> {
	const ready = await prepare(item);
	if (!ready) return;
	const session = await openCodeSessionAt(ready.root);
	session.prefill = {
		text: `Work on ${item.repo}#${item.number}: ${issueText(item, ready.body)}`,
		images: []
	};
}

/** A new guided-planning job for the issue, open in the Jobs tab and not saved. */
export async function planIssue(item: GitHubItem): Promise<void> {
	const ready = await prepare(item);
	if (!ready) return;
	newJobDraft({
		jobType: 'guided_planning',
		name: `${item.repo}#${item.number}`,
		workingDir: ready.root,
		config: {
			...getJobType('guided_planning')!.configDefaults(),
			initial_description: issueText(item, ready.body)
		}
	});
	setActiveTab('jobs');
}
