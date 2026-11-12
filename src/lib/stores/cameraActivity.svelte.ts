/**
 * Which cameras are in use right now, for the header's indicator. A camera
 * tool marks its camera busy around each capture (`withCameraActivity`); the
 * indicator shows while anything is.
 *
 * Entries are keyed by camera and kind, and counted, so two captures from one
 * camera at once keep it shown until both end, and other kinds of activity
 * (the ambient watcher) can be added without touching this.
 */

/** What a camera is doing. */
export type CameraActivityKind = 'look' | 'listen' | 'move' | 'watch';

export interface CameraActivity {
	cameraId: string;
	kind: CameraActivityKind;
}

const SEP = '\u0000';

// Raw: replaced whole on each change, never mutated.
let counts = $state.raw<Record<string, number>>({});

/** Mark `cameraId` as in use for `kind`. Pair with `endCameraActivity`. */
export function beginCameraActivity(cameraId: string, kind: CameraActivityKind): void {
	const key = `${cameraId}${SEP}${kind}`;
	counts = { ...counts, [key]: (counts[key] ?? 0) + 1 };
}

/** One use of `cameraId` for `kind` ended. */
export function endCameraActivity(cameraId: string, kind: CameraActivityKind): void {
	const key = `${cameraId}${SEP}${kind}`;
	const left = (counts[key] ?? 0) - 1;
	const next = { ...counts };
	if (left > 0) next[key] = left;
	else delete next[key];
	counts = next;
}

/** Run `fn` with `cameraId` shown as in use for `kind`. */
export async function withCameraActivity<T>(
	cameraId: string,
	kind: CameraActivityKind,
	fn: () => Promise<T>
): Promise<T> {
	beginCameraActivity(cameraId, kind);
	try {
		return await fn();
	} finally {
		endCameraActivity(cameraId, kind);
	}
}

/** Everything in use now, one entry per camera and kind. */
export function activeCameraUses(): CameraActivity[] {
	return Object.keys(counts).map((key) => {
		const [cameraId, kind] = key.split(SEP);
		return { cameraId, kind: kind as CameraActivityKind };
	});
}
