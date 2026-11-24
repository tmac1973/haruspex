import { describe, it, expect } from 'vitest';
import { renderSequenceReport } from './report';
import { planClips } from '#lib/sequence/spec/plan.ts';
import { LTX_MODEL, foxSpec } from '#lib/testing/sequenceSpecs.ts';

describe('renderSequenceReport', () => {
	it('says what was made, what was flagged, and where it all is', () => {
		const spec = foxSpec();
		const plan = planClips(spec, LTX_MODEL, true);
		const report = renderSequenceReport({
			spec,
			plan,
			clips: {
				'snow-01': { key: 'k', status: 'done', file: 'generated/snow-01.webm', seed: 7 },
				'snow-02': {
					key: 'k',
					status: 'done',
					file: 'generated/snow-02.webm',
					seed: 8,
					check: { ok: false, problem: 'the fox turned grey' }
				}
			},
			project: 'ep1/ep1.mlt',
			render: {
				path: 'ep1/renders/ep1.mp4',
				absPath: '/v/ep1/renders/ep1.mp4',
				check: {
					durationSecs: 120.4,
					expectedSecs: 120.4,
					sizeBytes: 1,
					width: 1280,
					height: 720,
					fps: 24,
					hasAudio: true,
					loudness: { lufs: -14.1, lra: 5, truePeakDb: -1.5 },
					problems: []
				}
			},
			music: [{ id: 'piano', file: 'music/piano.mp3' }],
			narration: [],
			notes: ['Re-anchoring is off.'],
			startedMs: 0,
			finishedMs: 150 * 60000
		});
		expect(report).toContain('# Fox seasons');
		expect(report).toContain(
			'Made in 2 h 30 min. 25 clips at 1280×704, 24 fps; 1 failed the seam check twice and was kept.'
		);
		expect(report).toContain('### snow: 60 s, 12 clips');
		expect(report).toContain('- snow-01: generated/snow-01.webm, seed 7');
		expect(report).toContain(
			'- snow-02: generated/snow-02.webm, seed 8 — **flagged:** the fox turned grey'
		);
		expect(report).toContain('Then a generated transition.');
		expect(report).toContain('music piano (music/piano.mp3)');
		expect(report).toContain('The project is ep1/ep1.mlt.');
		expect(report).toContain('120.4 s, 1280×720 at 24 fps, -14.1 LUFS.');
		expect(report).toContain('- Re-anchoring is off.');
	});
});
