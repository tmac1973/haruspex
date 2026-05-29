/**
 * Head + tail truncation for captured shell output.
 *
 * Compaction via LLM summarization is bounded by the model's own
 * context window — for a 500 KB dmesg, no single sub-agent call can
 * fit the input. Head + tail is the unbounded fallback: keep the
 * first N/2 bytes and last N/2 bytes verbatim, drop the middle with
 * a clear marker. For the dominant log-dump / dmesg / journalctl
 * case this is actually high-signal — kernel boot at the top, recent
 * activity at the bottom — and the marker tells the model it's
 * looking at a slice so it can coach the user toward a narrower
 * query (`dmesg | tail -200`, `--since '1 hour ago'`, etc.).
 *
 * We measure in UTF-8 bytes rather than UTF-16 code units so the
 * limit lines up roughly with token count for ASCII-heavy log
 * output (chars/4 rule of thumb). Cut points snap to the nearest
 * newline when one is close, to avoid mid-line slices.
 */

export interface TruncationResult {
	text: string;
	truncated: boolean;
	originalBytes: number;
}

const NEWLINE_SNAP_WINDOW = 0.25; // up to 25% of the half-budget to find a newline

export function truncateCapturedOutput(text: string, maxBytes: number): TruncationResult {
	if (maxBytes <= 0) {
		return { text, truncated: false, originalBytes: byteLength(text) };
	}
	const totalBytes = byteLength(text);
	if (totalBytes <= maxBytes) {
		return { text, truncated: false, originalBytes: totalBytes };
	}

	const halfBudget = Math.floor(maxBytes / 2);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder('utf-8', { fatal: false });
	const bytes = encoder.encode(text);

	let head = decoder.decode(bytes.slice(0, halfBudget));
	let tail = decoder.decode(bytes.slice(bytes.length - halfBudget));

	// Snap head end to the last newline within the snap window so we
	// don't cut a line in half. Same for the tail start.
	const snapWindow = Math.floor(halfBudget * NEWLINE_SNAP_WINDOW);
	const headSnap = head.lastIndexOf('\n');
	if (headSnap >= 0 && head.length - headSnap <= snapWindow) {
		head = head.slice(0, headSnap);
	}
	const tailSnap = tail.indexOf('\n');
	if (tailSnap >= 0 && tailSnap <= snapWindow) {
		tail = tail.slice(tailSnap + 1);
	}

	const droppedBytes = totalBytes - byteLength(head) - byteLength(tail);
	const marker = `\n\n[... middle truncated — ${formatBytes(totalBytes)} total, ${formatBytes(droppedBytes)} dropped from the middle. Ask the user to narrow the command (e.g. \`| tail -200\`, \`--since '1 hour ago'\`, \`| grep <pattern>\`) if you need the dropped region ...]\n\n`;

	return {
		text: `${head}${marker}${tail}`,
		truncated: true,
		originalBytes: totalBytes
	};
}

function byteLength(s: string): number {
	return new TextEncoder().encode(s).length;
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
	return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}
