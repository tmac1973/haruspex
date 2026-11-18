/**
 * A colour per other computer (plan/instance-sync/), the same everywhere it
 * shows: its sidebar sections, its tabs and its "Runs on" badges. Taken from
 * its install id, so it stays put across restarts and renames. This
 * computer's own rows have none.
 */

/** A hue for `instanceId`, 0–359. */
export function peerHue(instanceId: string): number {
	let h = 0;
	for (const ch of instanceId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return h % 360;
}

/** The computer's colour, readable on light and dark backgrounds. */
export function peerColor(instanceId: string): string {
	return `hsl(${peerHue(instanceId)} 60% 52%)`;
}
