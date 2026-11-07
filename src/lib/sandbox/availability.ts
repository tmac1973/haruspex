/**
 * Whether the Python runtime turned out to be missing this session.
 *
 * Packaged builds ship it; a dev checkout that never ran
 * scripts/fetch-pyodide.sh has none. Once the worker reports that, the
 * sandbox tools stop being offered (see the registry): a model told to run a
 * setup script it can't run only tried again, and in a live job twice
 * (#687). Its own module so the registry can ask without loading the worker.
 *
 * `probePythonRuntime` asks at startup too, so the tools are never offered in
 * a build that has no runtime: a model that followed a skill's run_python
 * step found out only by failing it, and its plan was built on Python (#1032).
 */

/** What the model is told: nothing it can fix, so do without. */
export const PYTHON_UNAVAILABLE =
	"Python isn't available in this Haruspex: its runtime is missing, and that can't be fixed from here. Do this without Python.";

let runtimeMissing = false;

export function noteRuntimeMissing(): void {
	runtimeMissing = true;
}

export function pythonRuntimeMissing(): boolean {
	return runtimeMissing;
}

/**
 * Whether the runtime's entry file is missing under `indexURL` (the app's
 * `/pyodide/`). static/pyodide/ is gitignored and filled by
 * scripts/fetch-pyodide.sh, so a fresh dev checkout has none. A built app
 * answers a missing file with the SPA's index.html and a 200, so an HTML
 * answer counts as missing too. A failed request proves nothing: false.
 */
export async function runtimeFileMissing(
	fetchFn: typeof fetch,
	indexURL: string
): Promise<boolean> {
	try {
		const resp = await fetchFn(indexURL + 'pyodide.asm.mjs', { method: 'HEAD' });
		return !resp.ok || (resp.headers.get('content-type') ?? '').includes('text/html');
	} catch {
		return false;
	}
}

/** Check once at startup, before any turn is offered the sandbox tools. */
export async function probePythonRuntime(
	fetchFn: typeof fetch = fetch,
	origin: string = location.origin
): Promise<void> {
	if (await runtimeFileMissing(fetchFn, new URL('/pyodide/', origin).href)) {
		console.warn(
			'python sandbox: the runtime is missing from /pyodide/ (run ./scripts/fetch-pyodide.sh)'
		);
		noteRuntimeMissing();
	}
}
