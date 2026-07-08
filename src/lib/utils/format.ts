/**
 * Human-readable formatting helpers shared across components.
 * Consolidates copies that previously lived in ModelsSection, the setup
 * page, and the jobs views.
 */

/** Byte count → `B` / `KB` / `MB` / `GB` with sensible precision. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
	return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/** Bytes-per-second → `KB/s` / `MB/s`. */
export function formatBytesPerSecond(bytesPerSec: number): string {
	if (bytesPerSec < 1048576) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
	return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
}

/** Today's date as e.g. `Wednesday, July 8, 2026` — the form the system
 * prompts embed. Previously re-spelled in three prompt builders. */
export function formatTodayLong(): string {
	return new Date().toLocaleDateString('en-US', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});
}

/** Duration in ms → `Ns` / `Nm Ns` / `Nh Nm` (min 1s). */
export function formatDuration(ms: number): string {
	const sec = Math.max(1, Math.round(ms / 1000));
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}
