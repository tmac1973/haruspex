//! Turns a stream of scored 16 ms frames into phrases: speech that starts
//! after a moment of voice and ends at a pause.

use std::collections::VecDeque;

/// Samples per frame: 16 ms at 16 kHz, what earshot scores.
pub const FRAME: usize = 256;
/// A score at or above this is voice.
pub const VOICE_THRESHOLD: f32 = 0.5;
/// Consecutive voiced frames that open a phrase (48 ms).
const START_FRAMES: usize = 3;
/// Frames kept from before the opening ones, so the first sound isn't clipped (320 ms).
const PREROLL_FRAMES: usize = 20;
/// Consecutive non-voice frames that close a phrase (800 ms).
const END_FRAMES: usize = 50;
/// Trailing silence left on a finished phrase (about 200 ms).
const TAIL_FRAMES: usize = 12;
/// A phrase with fewer voiced frames than this is a cough or a click, not speech (about 300 ms).
const MIN_SPEECH_FRAMES: usize = 19;
/// A phrase is cut at 30 s, whisper's window, and a new one opens.
const MAX_PHRASE_FRAMES: usize = 1875;

enum State {
    Idle {
        recent: VecDeque<[f32; FRAME]>,
        voiced_run: usize,
    },
    InPhrase {
        samples: Vec<f32>,
        frames: usize,
        voiced: usize,
        silence_run: usize,
    },
}

pub struct Segmenter {
    state: State,
}

impl Default for Segmenter {
    fn default() -> Self {
        Self {
            state: Self::idle(),
        }
    }
}

impl Segmenter {
    fn idle() -> State {
        State::Idle {
            recent: VecDeque::with_capacity(PREROLL_FRAMES + START_FRAMES),
            voiced_run: 0,
        }
    }

    /// Drop whatever is in progress.
    pub fn reset(&mut self) {
        self.state = Self::idle();
    }

    /// Feed one frame and its voice score; returns a finished phrase's samples.
    pub fn push(&mut self, frame: &[f32; FRAME], score: f32) -> Option<Vec<f32>> {
        let voice = score >= VOICE_THRESHOLD;
        match &mut self.state {
            State::Idle { recent, voiced_run } => {
                if recent.len() == PREROLL_FRAMES + START_FRAMES {
                    recent.pop_front();
                }
                recent.push_back(*frame);
                *voiced_run = if voice { *voiced_run + 1 } else { 0 };
                if *voiced_run >= START_FRAMES {
                    let samples: Vec<f32> = recent.iter().flatten().copied().collect();
                    self.state = State::InPhrase {
                        frames: recent.len(),
                        samples,
                        voiced: *voiced_run,
                        silence_run: 0,
                    };
                }
                None
            }
            State::InPhrase {
                samples,
                frames,
                voiced,
                silence_run,
            } => {
                samples.extend_from_slice(frame);
                *frames += 1;
                if voice {
                    *voiced += 1;
                    *silence_run = 0;
                } else {
                    *silence_run += 1;
                }
                let ended = *silence_run >= END_FRAMES;
                if !ended && *frames < MAX_PHRASE_FRAMES {
                    return None;
                }
                let trim = silence_run.saturating_sub(TAIL_FRAMES) * FRAME;
                let mut phrase = std::mem::take(samples);
                phrase.truncate(phrase.len() - trim);
                let enough = *voiced >= MIN_SPEECH_FRAMES;
                self.state = if ended {
                    Self::idle()
                } else {
                    State::InPhrase {
                        samples: Vec::new(),
                        frames: 0,
                        voiced: 0,
                        silence_run: 0,
                    }
                };
                enough.then_some(phrase)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed `n` frames of one score; collect the phrases that come out.
    fn feed(seg: &mut Segmenter, n: usize, score: f32, out: &mut Vec<Vec<f32>>) {
        let frame = [0.1f32; FRAME];
        for _ in 0..n {
            if let Some(p) = seg.push(&frame, score) {
                out.push(p);
            }
        }
    }

    /// Frames in a duration, at 16 ms each.
    fn ms(ms: usize) -> usize {
        ms / 16
    }

    #[test]
    fn one_second_of_voice_gives_one_phrase_with_preroll() {
        let mut seg = Segmenter::default();
        let mut out = Vec::new();
        feed(&mut seg, ms(1000), 0.0, &mut out);
        feed(&mut seg, ms(1000), 0.9, &mut out);
        feed(&mut seg, ms(1200), 0.0, &mut out);
        assert_eq!(out.len(), 1);
        let frames = out[0].len() / FRAME;
        // Pre-roll + the voice + the kept tail.
        assert_eq!(frames, PREROLL_FRAMES + ms(1000) + TAIL_FRAMES);
    }

    #[test]
    fn a_short_blip_is_dropped() {
        let mut seg = Segmenter::default();
        let mut out = Vec::new();
        feed(&mut seg, ms(200), 0.9, &mut out);
        feed(&mut seg, ms(1200), 0.0, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn a_short_pause_stays_in_one_phrase() {
        let mut seg = Segmenter::default();
        let mut out = Vec::new();
        feed(&mut seg, ms(2000), 0.9, &mut out);
        feed(&mut seg, ms(500), 0.0, &mut out);
        feed(&mut seg, ms(2000), 0.9, &mut out);
        feed(&mut seg, ms(1200), 0.0, &mut out);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn long_speech_is_cut_at_thirty_seconds() {
        let mut seg = Segmenter::default();
        let mut out = Vec::new();
        feed(&mut seg, ms(35_000), 0.9, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len() / FRAME, MAX_PHRASE_FRAMES);
        feed(&mut seg, ms(1200), 0.0, &mut out);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn reset_mid_phrase_gives_nothing() {
        let mut seg = Segmenter::default();
        let mut out = Vec::new();
        feed(&mut seg, ms(2000), 0.9, &mut out);
        seg.reset();
        feed(&mut seg, ms(1200), 0.0, &mut out);
        assert!(out.is_empty());
    }
}
