/**
 * The camera approval prompt's question, shared by the desktop modal and the
 * remote page (Settings → Remote control), which must not import the store.
 */

/** What the assistant wants to do with the cameras. */
export type CameraAction = 'look' | 'listen' | 'move' | 'save_preset' | 'read_log';

const VERBS: Record<CameraAction, string> = {
	look: 'look through',
	listen: 'listen on',
	move: 'move',
	save_preset: 'save a preset on',
	read_log: 'read the log of'
};

/** "Let the assistant look through Kitchen and Porch?" */
export function cameraUseQuestion(request: { cameras: string[]; action: CameraAction }): string {
	return `Let the assistant ${VERBS[request.action] ?? 'use'} ${joinNames(request.cameras)}?`;
}

function joinNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? 'a camera';
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
