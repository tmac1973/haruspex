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
}

const rows = new Map<string, Row>();
let seq = 0;

function row(id: unknown): Row {
	const r = rows.get(String(id));
	if (!r) throw new Error(`no code session ${String(id)}`);
	return r;
}

/** A clock that always moves forward, so list order is stable. */
let clock = 1_700_000_000_000;
const now = () => ++clock;

export const CODE_DB: Record<string, Handler> = {
	code_session_list: () =>
		[...rows.values()]
			.sort((a, b) => b.updated_at - a.updated_at)
			.map(({ id, title, root, updated_at, forked_from }) => ({
				id,
				title,
				root,
				updated_at,
				forked_from
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
			updated_at: t
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
