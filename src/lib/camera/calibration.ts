/**
 * A network camera's pan as Calibrate in Settings → Cameras measured it, in
 * picture widths (see `camera/calibrate.rs`).
 */
import type { PtzCalibration } from '#lib/ipc/gen/PtzCalibration.ts';

/** "about 5 picture widths end to end; home is 2.8 from the left end" */
export function describeRange(cal: PtzCalibration): string {
	const round = (v: number) => Math.round(v * 10) / 10;
	const range = `about ${round(cal.rangePulses * cal.viewsPerPulse)} picture widths end to end`;
	if (cal.homePulses == null) return range;
	return `${range}; home is ${round(cal.homePulses * cal.viewsPerPulse)} from the left end`;
}
