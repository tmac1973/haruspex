/**
 * Whether the Python runtime turned out to be missing this session.
 *
 * Packaged builds ship it; a dev checkout that never ran
 * scripts/fetch-pyodide.sh has none. Once the worker reports that, the
 * sandbox tools stop being offered (see the registry): a model told to run a
 * setup script it can't run only tried again, and in a live job twice
 * (#687). Its own module so the registry can ask without loading the worker.
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
