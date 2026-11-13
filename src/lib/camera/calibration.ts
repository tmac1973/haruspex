/**
 * A network camera's pan as Calibrate in Settings → Cameras measured it, in
 * picture widths (see `camera/calibrate.rs`).
 */
import type { PtzCalibration } from '#lib/ipc/gen/PtzCalibration.ts';

/**
 * "about 5 picture widths end to end; home is 2.8 from the left end; tilts
 * about 1.5 picture heights, home 0.8 from the bottom"
 */
export function describeRange(cal: PtzCalibration): string {
	const round = (v: number) => Math.round(v * 10) / 10;
	let text = `about ${round(cal.rangePulses * cal.viewsPerPulse)} picture widths end to end`;
	if (cal.homePulses != null) {
		text += `; home is ${round(cal.homePulses * cal.viewsPerPulse)} from the left end`;
	}
	const tilt = cal.tilt;
	if (tilt) {
		text += `; tilts about ${round(tilt.rangePulses * tilt.viewsPerPulse)} picture heights, home ${round(tilt.homePulses * tilt.viewsPerPulse)} from the bottom`;
	}
	const sweep = cal.sweep;
	if (sweep) {
		text += `; looks around only from ${round(sweep.from * cal.viewsPerPulse)} to ${round(sweep.to * cal.viewsPerPulse)} from the left end`;
	}
	return text;
}
