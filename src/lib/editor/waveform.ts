/**
 * A sound's outline for the audio viewer: the loudest sample in each of
 * `buckets` equal slices, across every channel, from 0 to 1.
 */
export function peaks(channels: Float32Array[], buckets: number): number[] {
	const length = channels[0]?.length ?? 0;
	if (length === 0 || buckets <= 0) return [];
	const out: number[] = [];
	for (let b = 0; b < buckets; b++) {
		const start = Math.floor((b * length) / buckets);
		const end = Math.max(start + 1, Math.floor(((b + 1) * length) / buckets));
		let max = 0;
		for (const data of channels) {
			for (let i = start; i < end && i < length; i++) {
				const v = Math.abs(data[i]);
				if (v > max) max = v;
			}
		}
		out.push(Math.min(1, max));
	}
	return out;
}

/** `m:ss`. */
export function clock(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
