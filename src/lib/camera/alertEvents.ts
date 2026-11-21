/**
 * Camera alerts' in-app signals. The captioner (and room checks) report each
 * judged event here, and that it can't judge one at all; whoever acts on
 * them — the desktop notification below, the alert emails — subscribes.
 */
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';
import { notify } from '#lib/notify.ts';
import { errMessage } from '#lib/utils/error.ts';

type JudgedListener = (event: CameraEvent, camera: CameraConfig) => void | Promise<void>;
type CannotJudgeListener = (cameraId: string) => void | Promise<void>;

const judged = new Set<JudgedListener>();
const cannotJudge = new Set<CannotJudgeListener>();

/** Call `fn` with every event once it is judged; returns the unsubscribe. */
export function onJudged(fn: JudgedListener): () => void {
	judged.add(fn);
	return () => judged.delete(fn);
}

/** Call `fn` whenever an Alerts-on event is left waiting because no model can judge it. */
export function onCannotJudge(fn: CannotJudgeListener): () => void {
	cannotJudge.add(fn);
	return () => cannotJudge.delete(fn);
}

function run(fn: () => void | Promise<void>): void {
	try {
		void Promise.resolve(fn()).catch((e) => console.warn('Camera alerts:', errMessage(e)));
	} catch (e) {
		console.warn('Camera alerts:', errMessage(e));
	}
}

/** An event was judged: a desktop notification for Urgent, then every listener. */
export function emitJudged(event: CameraEvent, camera: CameraConfig): void {
	if (event.alertLevel === 'urgent') {
		void notify(`Urgent: ${camera.name}`, event.alertReason || event.caption || 'Camera alert');
	}
	for (const fn of judged) run(() => fn(event, camera));
}

/** An Alerts-on event on `cameraId` is waiting for a model that can judge it. */
export function emitCannotJudge(cameraId: string): void {
	for (const fn of cannotJudge) run(() => fn(cameraId));
}

/** For tests: drop every listener. */
export function _resetAlertEventsForTests(): void {
	judged.clear();
	cannotJudge.clear();
}
