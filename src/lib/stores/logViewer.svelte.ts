/**
 * Log Viewer visibility. Lives in a tiny store (rather than layout-local
 * state) so error toasts raised anywhere in the app can offer a
 * "View logs" action that opens the same viewer as the header logs icon
 * and the server status badge. The LogViewer component itself is mounted
 * once in the root layout.
 */

let open = $state(false);

export function isLogViewerOpen(): boolean {
	return open;
}

export function openLogViewer(): void {
	open = true;
}

export function closeLogViewer(): void {
	open = false;
}

export function toggleLogViewer(): void {
	open = !open;
}
