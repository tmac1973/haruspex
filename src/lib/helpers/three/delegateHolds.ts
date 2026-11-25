/**
 * The files a running 3D delegate owns. `delegate_3d` runs in the background
 * by default and writes straight into the session folder, so while it works,
 * any other write to its build module, animation module or .glb is refused:
 * the main agent's, another session's on the same folder, or a second
 * delegate's. Its own writes pass, since they are on its `writablePaths`.
 *
 * Keyed by the folder and the path in it, so sessions sharing a folder see
 * each other's holds. Kept for the app's life; each hold is given back when
 * its run ends, however it ends.
 */

/** Held file → the delegate holding it. */
const held = new Map<string, { label: string; token: symbol }>();

function key(folder: string, relPath: string): string {
	return `${folder.replace(/[/\\]+$/, '')}/${relPath}`;
}

/** Hold `relPaths` in `folder` for `label`; the function gives them back. */
export function holdDelegateFiles(folder: string, relPaths: string[], label: string): () => void {
	const keys = relPaths.map((p) => key(folder, p));
	const token = Symbol(label);
	for (const k of keys) held.set(k, { label, token });
	return () => {
		for (const k of keys) if (held.get(k)?.token === token) held.delete(k);
	};
}

/** The label of the delegate holding `relPath` in `folder`, or null. */
export function delegateHolding(folder: string, relPath: string): string | null {
	return held.get(key(folder, relPath))?.label ?? null;
}

/** What a write to a held file is told. */
export function heldFileRefusal(relPath: string, label: string): string {
	return `${relPath} belongs to the 3D delegate "${label}", which is still working on it. Wait for its report; to change the asset, call delegate_3d again with the same path once it has finished.`;
}

/** For tests: forget every hold. */
export function clearDelegateHolds(): void {
	held.clear();
}
