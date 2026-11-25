/**
 * The File on GitHub dialog's open request: a notebook or card's title and
 * Markdown, and whether it starts as a new issue or a comment. One at a
 * time; opening another replaces it. Mounted in the root layout
 * (`GitHubIssueModal.svelte`).
 */

export type GitHubFileMode = 'issue' | 'comment';

export interface GitHubFileRequest {
	title: string;
	body: string;
	mode: GitHubFileMode;
}

let pending = $state<GitHubFileRequest | null>(null);

export function openGitHubFile(request: GitHubFileRequest): void {
	pending = request;
}

export function getGitHubFile(): GitHubFileRequest | null {
	return pending;
}

export function closeGitHubFile(): void {
	pending = null;
}
