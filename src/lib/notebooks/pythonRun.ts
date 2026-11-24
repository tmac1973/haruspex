/**
 * Running a notebook's Python card in the Pyodide sandbox. Each notebook has
 * its own sandbox (`notebook-<id>`), so variables carry from card to card
 * like a Jupyter notebook. Before the code runs, the notebook's tables are
 * set up as pandas DataFrames in `tables` (by card title) with `table(name)`
 * to fetch one. Code never changes a table; a DataFrame left in `result`
 * can be saved as a new table card from the output.
 */
import * as api from '#lib/notebooks/api.ts';
import type { NotebookCard } from '#lib/notebooks/api.ts';
import { columnsOf } from '#lib/notebooks/columns.ts';
import { runPython } from '#lib/sandbox/sandbox.ts';
import type { Artifact, ToolResult } from '#lib/sandbox/protocol.ts';
import { outputOf, type PythonOutput } from '#lib/notebooks/pythonOutput.ts';

export { outputOf, type PythonOutput };
import { getSettings } from '#lib/stores/settings.ts';
import { pythonRuntimeMissing } from '#lib/sandbox/availability.ts';

/** The most rows a `result` DataFrame saves for "Save as table card". */
export const RESULT_ROWS = 5000;
/** A picture bigger than this isn't kept with the card; nor anything past the total. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export function sandboxIdFor(notebookId: string): string {
	return `notebook-${notebookId}`;
}

/** Why Python can't run here, or null when it can. */
export function pythonUnavailable(): string | null {
	if (!getSettings().sandboxEnabled)
		return 'Python is off in Settings → Chat → Enable Python sandbox.';
	if (pythonRuntimeMissing()) return 'The Python runtime is missing from this build.';
	return null;
}

/** Whether a table the output read has changed since. */
export function isStale(output: PythonOutput, cards: NotebookCard[]): boolean {
	return Object.entries(output.read_versions ?? {}).some(([id, v]) => {
		const c = cards.find((x) => x.id === id);
		return !c || c.version !== v;
	});
}

interface TableSpec {
	name: string;
	columns: { id: string; name: string; type: string }[];
	rows: Record<string, unknown>[];
}

/** The notebook's tables, every row, named uniquely by card title. */
export async function tableSpecs(cards: NotebookCard[]): Promise<TableSpec[]> {
	const seen = new Map<string, number>();
	const specs: TableSpec[] = [];
	for (const c of cards.filter((x) => x.kind === 'table' && x.deleted_at === null)) {
		const base = c.title.trim() || 'Table';
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		const rows = c.row_count > c.rows.length ? await api.getRows(c.id, 0, c.row_count) : c.rows;
		specs.push({
			name: n === 1 ? base : `${base} (${n})`,
			columns: columnsOf(api.parseMeta(c.meta)).map(({ id, name, type }) => ({ id, name, type })),
			rows: rows.map((r) => api.parseMeta<Record<string, unknown>>(r.cells))
		});
	}
	return specs;
}

/**
 * The code that sets up `tables` and `table()`. The data goes in as a JSON
 * string literal (JSON's string escapes are Python's too).
 */
export function prelude(specs: TableSpec[]): string {
	const literal = JSON.stringify(JSON.stringify(specs));
	return `import json as _nb_json
import pandas as pd

def _nb_frames(spec):
    out = {}
    for t in spec:
        names = [c["name"] for c in t["columns"]]
        df = pd.DataFrame([[r.get(c["id"]) for c in t["columns"]] for r in t["rows"]], columns=names)
        for c in t["columns"]:
            col = c["name"]
            if c["type"] in ("number", "currency"):
                df[col] = pd.to_numeric(df[col], errors="coerce")
            elif c["type"] == "date":
                df[col] = pd.to_datetime(df[col], errors="coerce")
            elif c["type"] == "checkbox":
                df[col] = df[col].fillna(False).astype(bool)
        out[t["name"]] = df
    return out

tables = _nb_frames(_nb_json.loads(${literal}))

def table(name):
    """A notebook table as a DataFrame, by its card title."""
    if name in tables:
        return tables[name].copy()
    raise KeyError(f"No table {name!r}. Tables: {', '.join(tables) or 'none'}")
`;
}

/** Prints `result` as CSV when it is a DataFrame; nothing otherwise. */
export const RESULT_CSV_CODE = `_nb_r = globals().get("result")
if isinstance(_nb_r, pd.DataFrame):
    print(_nb_r.head(${RESULT_ROWS}).to_csv(index=False), end="")
`;

/** Keep the artifacts a card can hold: pictures under 2 MB, 5 MB in all. */
export function keepArtifacts(list: Artifact[]): { kept: Artifact[]; notes: string[] } {
	const kept: Artifact[] = [];
	const notes: string[] = [];
	let total = 0;
	for (const a of list) {
		const size = a.kind === 'image' ? a.dataUrl.length : a.kind === 'html' ? a.html.length : 0;
		if (a.kind === 'image' && size > MAX_IMAGE_BYTES) {
			notes.push('A picture over 2 MB was left out.');
			continue;
		}
		if (total + size > MAX_ARTIFACT_BYTES) {
			notes.push('Output past 5 MB was left out.');
			break;
		}
		if (a.kind === 'image' || a.kind === 'html') {
			kept.push(a);
			total += size;
		}
	}
	return { kept, notes };
}

/**
 * Run a Python card's code (`code`, or the card's own) and return what to
 * store as its output. Doesn't save; the caller does, with its source.
 */
export async function runPythonCard(
	card: NotebookCard,
	cards: NotebookCard[],
	code = card.body,
	timeoutMs = Math.round((getSettings().sandboxTimeoutSeconds ?? 60) * 1000)
): Promise<PythonOutput> {
	const why = pythonUnavailable();
	if (why) throw new Error(why);
	const id = sandboxIdFor(card.notebook_id);
	const specs = await tableSpecs(cards);
	const setup = await runPython(id, prelude(specs), { timeoutMs });
	if (setup.error) throw new Error(`Setting up the tables failed: ${setup.error}`);
	const started = Date.now();
	const run: ToolResult = await runPython(id, code, { timeoutMs });
	let resultCsv: string | undefined;
	if (!run.error) {
		const csv = await runPython(id, RESULT_CSV_CODE, { timeoutMs: 30_000 });
		if (!csv.error && csv.stdout.trim()) resultCsv = csv.stdout;
	}
	const { kept, notes } = keepArtifacts(run.artifactsList ?? []);
	const read: Record<string, number> = {};
	for (const c of cards) if (c.kind === 'table') read[c.id] = c.version;
	return {
		stdout: run.stdout,
		stderr: run.stderr,
		result: run.result,
		error: run.error,
		artifacts: kept,
		duration_ms: run.duration_ms || Date.now() - started,
		ran_at: Date.now(),
		read_versions: read,
		result_csv: resultCsv,
		notes: [...(run.notes ?? []), ...notes]
	};
}

/** A card's meta with a new output. */
export function withOutput(card: NotebookCard, output: PythonOutput): string {
	return JSON.stringify({ ...api.parseMeta(card.meta), output });
}
