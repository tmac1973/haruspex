import type { PeerView } from '#lib/peers/store.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';

export type PeerOperation = Parameters<PeerView['client']['op']>[0];

/**
 * An operation on another computer for a remote chat or Code session: its
 * failure goes to `setError` as the error the view shows, and the result is
 * undefined. `setError(null)` first clears the last one.
 */
export async function peerOp<T>(
	view: PeerView,
	operation: PeerOperation,
	setError: (message: string | null) => void
): Promise<T | undefined> {
	setError(null);
	try {
		return await view.client.op<T>(operation);
	} catch (e) {
		setError(errMessage(e));
		return undefined;
	}
}
