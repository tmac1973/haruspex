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
	const off = cal.homeOffset ?? { pan: 0, tilt: 0 };
	const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
	const home = cal.homeOffset ? 'home (set here)' : 'home';
	let text = `about ${round(cal.rangePulses * cal.viewsPerPulse)} picture widths end to end`;
	if (cal.homePulses != null) {
		const pan = clamp(cal.homePulses + off.pan, cal.rangePulses);
		text += `; ${home} is ${round(pan * cal.viewsPerPulse)} from the left end`;
	}
	const tilt = cal.tilt;
	if (tilt) {
		const up = clamp(tilt.homePulses + off.tilt, tilt.rangePulses);
		text += `; tilts about ${round(tilt.rangePulses * tilt.viewsPerPulse)} picture heights, ${home} ${round(up * tilt.viewsPerPulse)} from the bottom`;
	}
	const sweep = cal.sweep;
	if (sweep) {
		text += `; looks around only from ${round(sweep.from * cal.viewsPerPulse)} to ${round(sweep.to * cal.viewsPerPulse)} from the left end`;
	}
	return text;
}
