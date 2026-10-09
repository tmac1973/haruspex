/**
 * The Code tab's commands for the UI end-to-end tests: an in-memory
 * `code_sessions` table, no background processes, and a project folder with
 * one file the scripted agent edits. See `installMocks.ts`.
 */

type Args = Record<string, unknown> | undefined;
type Handler = (args: Args) => unknown;

interface Row {
	id: string;
	title: string;
	root: string;
	backend: string | null;
	reasoning_effort: string | null;
	thread: string;
	forked_from: string | null;
	forked_at: number | null;
	created_at: number;
	updated_at: number;
	read_only: boolean;
	worktree: string | null;
}

const rows = new Map<string, Row>();
let seq = 0;

function row(id: unknown): Row {
	const r = rows.get(String(id));
	if (!r) throw new Error(`no code session ${String(id)}`);
	return r;
}

/**
 * The project's git state: a clean repo on `main`. A spec that wants changes
 * in it mocks `code_git_status`.
 */
const git = { branch: 'main', branches: ['feature', 'main'], changed: 0 };

/** A clock that always moves forward, so list order is stable. */
let clock = 1_700_000_000_000;
const now = () => ++clock;

export const CODE_DB: Record<string, Handler> = {
	code_session_list: () =>
		[...rows.values()]
			.sort((a, b) => b.updated_at - a.updated_at)
			.map(({ id, title, root, updated_at, forked_from, read_only, worktree }) => ({
				id,
				title,
				root,
				updated_at,
				forked_from,
				read_only,
				worktree
			})),
	code_session_create: (a) => {
		const t = now();
		const r: Row = {
			id: `code-${++seq}`,
			title: '',
			root: String(a?.root ?? ''),
			backend: (a?.backend as string | null) ?? null,
			reasoning_effort: (a?.effort as string | null) ?? null,
			thread: '',
			forked_from: null,
			forked_at: null,
			created_at: t,
			updated_at: t,
			read_only: false,
			worktree: null
		};
		rows.set(r.id, r);
		return { ...r };
	},
	code_session_load: (a) => ({ ...row(a?.id) }),
	code_session_save: (a) => {
		const r = row(a?.id);
		r.thread = String(a?.thread ?? '');
		if (typeof a?.title === 'string') r.title = a.title;
		r.updated_at = now();
		return null;
	},
	code_session_update_meta: (a) => {
		const r = row(a?.id);
		const patch = (a?.patch ?? {}) as Record<string, unknown>;
		if (typeof patch.title === 'string') r.title = patch.title;
		if ('backend' in patch) r.backend = (patch.backend as string | null) ?? null;
		if ('effort' in patch) r.reasoning_effort = (patch.effort as string | null) ?? null;
		return null;
	},
	code_session_delete: (a) => {
		rows.delete(String(a?.id));
		return null;
	},
	code_session_fork: (a) => {
		const src = row(a?.id);
		const at = Number(a?.at ?? 0);
		const thread = JSON.parse(src.thread || '{"version":1,"messages":[]}');
		if (at > thread.messages.length) throw new Error('fork point past the end');
		const cut = (m: Record<string, unknown> | undefined) =>
			Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => Number(k) < at));
		const t = now();
		const title = `${src.title} (fork)`.trim();
		// A worktree fork is rooted beside the project, on a branch named from its title.
		const branch = title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '');
		const worktree = a?.mode === 'worktree' ? `/e2e/project-worktrees/${branch}` : null;
		if (worktree) git.branches = [...git.branches, branch].sort();
		const r: Row = {
			...src,
			id: `code-${++seq}`,
			title,
			root: worktree ?? src.root,
			read_only: a?.mode !== 'worktree',
			worktree,
			thread: JSON.stringify({
				...thread,
				messages: thread.messages.slice(0, at),
				messageSteps: cut(thread.messageSteps),
				messageStats: cut(thread.messageStats),
				messageStops: cut(thread.messageStops),
				messageHistorySent: cut(thread.messageHistorySent)
			}),
			forked_from: src.id,
			forked_at: at,
			created_at: t,
			updated_at: t
		};
		rows.set(r.id, r);
		return { ...r };
	},
	// One window in the browser: every claim is the main window's.
	code_session_claim: () => ({ owner: null, handoff: null }),
	code_session_release: () => null,
	code_session_open_ids: () => [...rows.keys()],

	// One writer per folder, and nobody else writing in these tests.
	code_lease_take: () => null,
	code_lease_release: () => null,
	code_notice_record: () => null,
	code_notices_take: (a) => ({ notices: [], now: Number(a?.since ?? 0) }),

	code_git_status: (a) => {
		const folder = String(a?.folder ?? '');
		const wt = folder.match(/^\/e2e\/project-worktrees\/([^/]+)/);
		if (!wt && !folder.startsWith('/e2e/project')) return null;
		return {
			repo_root: wt ? wt[0] : '/e2e/project',
			branch: wt ? wt[1] : git.branch,
			head: 'abc1234',
			changed: wt ? 0 : git.changed,
			untracked: 0,
			linked_worktree: !!wt
		};
	},
	code_git_branches: () => git.branches,
	code_git_switch: (a) => {
		if (git.changed > 0)
			throw new Error('error: Your local changes would be overwritten by checkout');
		git.branch = String(a?.branch);
		return null;
	},
	code_git_create_branch: (a) => {
		git.branch = String(a?.branch);
		git.branches = [...git.branches, git.branch].sort();
		return null;
	},
	code_git_worktree_remove: () => ({ kind: 'removed' }),

	code_bg_status: () => [],
	code_bg_stop_owner: () => 0,
	open_folder: () => null,
	'plugin:dialog|open': () => '/e2e/project',

	// The scripted agent's tools, in the project above. Nothing of the
	// app's own is protected from them here.
	app_protected_targets: () => ({ home: '/e2e', paths: [], ports: [] }),
	fs_edit_text: () => ({
		first_changed_line: 1,
		line_before: '# Helo',
		line_after: '# Hello',
		used_fuzzy: false
	}),
	run_command_capture: () => ({
		stdout: '# Hello\n\nA project for the e2e tests.\n',
		stderr: '',
		exit_code: 0,
		duration_ms: 12,
		killed: false,
		out_of_memory: false,
		memory_limit_mb: null
	})
};
