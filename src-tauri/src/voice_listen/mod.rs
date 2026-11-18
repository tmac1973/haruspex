//! Constant listening: the mic stays open, speech is split into phrases at
//! pauses (earshot), and each phrase is transcribed by whisper-server in
//! order. Everything goes out as `voice://listen` events; audio never
//! crosses IPC.

mod resample;
mod segmenter;

use crate::audio::{
    encode_wav, open_input_stream, MicGuard, MicLock, MicUser, WHISPER_SAMPLE_RATE,
};
use crate::sync_util::LockExt;
use crate::tts::TtsEngine;
use crate::whisper::{WhisperServer, WhisperStatus};
use log::{info, warn};
use resample::StreamResampler;
use segmenter::{Segmenter, FRAME};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

const EVENT: &str = "voice://listen";
/// No phrase for this long and listening stops by itself.
const IDLE_STOP: Duration = Duration::from_secs(300);
/// After audio stops playing, keep ignoring the mic this long (room echo).
const HOLD_TAIL: Duration = Duration::from_millis(400);
/// Mic chunks waiting for the worker; more than this and new ones are dropped.
const CHUNK_QUEUE: usize = 64;

/// Why listening ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub enum StopReason {
    User,
    Idle,
    Device,
}

/// What the listener tells the webviews. Every event names its session so
/// each window acts only on the one it started.
#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "type")]
pub enum ListenEvent {
    Started {
        session: u32,
    },
    Paused {
        session: u32,
        paused: bool,
    },
    PhraseQueued {
        session: u32,
        seq: u32,
    },
    Phrase {
        session: u32,
        seq: u32,
        text: String,
    },
    Error {
        session: u32,
        message: String,
    },
    Stopped {
        session: u32,
        reason: StopReason,
    },
}

fn emit(app: &AppHandle, evt: ListenEvent) {
    let _ = app.emit(EVENT, evt);
}

struct ActiveListen {
    session: u32,
    stop: Arc<AtomicBool>,
    hold: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    // Dropped after the worker is told to stop: the stream first (no more
    // callbacks), then the mic lock.
    _stream: cpal::Stream,
    _guard: MicGuard,
}

pub struct VoiceListener {
    active: Mutex<Option<ActiveListen>>,
    next_session: AtomicU32,
}

impl VoiceListener {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(None),
            next_session: AtomicU32::new(1),
        }
    }

    /// Take the active session if it is `session`; the worker ends its own
    /// session this way (it can't join itself, so its handle is detached).
    fn clear_if(&self, session: u32) -> bool {
        let mut active = self.active.lock_or_recover();
        if active.as_ref().is_some_and(|a| a.session == session) {
            if let Some(mut a) = active.take() {
                a.stop.store(true, Ordering::SeqCst);
                a.worker.take();
            }
            true
        } else {
            false
        }
    }
}

/// Everything the worker thread needs.
struct Worker {
    app: AppHandle,
    session: u32,
    rx: Receiver<Vec<f32>>,
    native_rate: u32,
    stop: Arc<AtomicBool>,
    hold: Arc<AtomicBool>,
    device_failed: Arc<AtomicBool>,
    phrases: UnboundedSender<(u32, Vec<f32>)>,
}

impl Worker {
    fn end(&self, reason: StopReason) {
        if self.app.state::<VoiceListener>().clear_if(self.session) {
            info!("Constant listening stopped: {reason:?}");
            emit(
                &self.app,
                ListenEvent::Stopped {
                    session: self.session,
                    reason,
                },
            );
        }
    }

    fn run(self) {
        let mut resampler = StreamResampler::new(self.native_rate, WHISPER_SAMPLE_RATE);
        let mut detector = earshot::Detector::default_boxed();
        let mut segmenter = Segmenter::default();
        let mut pending: Vec<f32> = Vec::new();
        let mut held = false;
        let mut tail_until: Option<Instant> = None;
        let mut last_activity = Instant::now();
        let mut seq: u32 = 0;
        let mut frame = [0f32; FRAME];

        loop {
            if self.stop.load(Ordering::SeqCst) {
                return;
            }
            if self.device_failed.load(Ordering::SeqCst) {
                return self.end(StopReason::Device);
            }

            let want_hold =
                self.hold.load(Ordering::SeqCst) || self.app.state::<TtsEngine>().is_playing();
            if want_hold && !held {
                held = true;
                tail_until = None;
                segmenter.reset();
                detector.reset();
                pending.clear();
                emit(
                    &self.app,
                    ListenEvent::Paused {
                        session: self.session,
                        paused: true,
                    },
                );
            } else if !want_hold && held {
                held = false;
                tail_until = Some(Instant::now() + HOLD_TAIL);
            }
            if tail_until.is_some_and(|t| Instant::now() >= t) {
                tail_until = None;
                emit(
                    &self.app,
                    ListenEvent::Paused {
                        session: self.session,
                        paused: false,
                    },
                );
            }
            if held || tail_until.is_some() {
                last_activity = Instant::now();
            }
            if last_activity.elapsed() >= IDLE_STOP {
                return self.end(StopReason::Idle);
            }

            let chunk = match self.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(chunk) => chunk,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            if held || tail_until.is_some() {
                continue;
            }

            resampler.push(&chunk, &mut pending);
            let mut used = 0;
            while pending.len() - used >= FRAME {
                for (dst, src) in frame.iter_mut().zip(&pending[used..used + FRAME]) {
                    *dst = src.clamp(-1.0, 1.0);
                }
                used += FRAME;
                let score = detector.predict_f32(&frame);
                if let Some(phrase) = segmenter.push(&frame, score) {
                    seq += 1;
                    last_activity = Instant::now();
                    emit(
                        &self.app,
                        ListenEvent::PhraseQueued {
                            session: self.session,
                            seq,
                        },
                    );
                    let _ = self.phrases.send((seq, phrase));
                }
            }
            pending.drain(..used);
        }
    }
}

/// Transcribe phrases one at a time, so their text comes out in order.
fn spawn_transcriber(app: AppHandle, session: u32) -> UnboundedSender<(u32, Vec<f32>)> {
    let (tx, mut rx) = unbounded_channel::<(u32, Vec<f32>)>();
    tauri::async_runtime::spawn(async move {
        while let Some((seq, samples)) = rx.recv().await {
            let evt = match encode_wav(&samples, WHISPER_SAMPLE_RATE) {
                Ok(wav) => match app.state::<WhisperServer>().transcribe(wav).await {
                    Ok(text) => ListenEvent::Phrase { session, seq, text },
                    Err(message) => ListenEvent::Error { session, message },
                },
                Err(message) => ListenEvent::Error { session, message },
            };
            // A failed phrase still settles its place in the queue.
            if let ListenEvent::Error { .. } = evt {
                emit(
                    &app,
                    ListenEvent::Phrase {
                        session,
                        seq,
                        text: String::new(),
                    },
                );
            }
            emit(&app, evt);
        }
    });
    tx
}

/// Open the mic and start listening; returns the session id.
#[tauri::command]
pub async fn voice_listen_start(
    app: AppHandle,
    listener: tauri::State<'_, VoiceListener>,
    mic: tauri::State<'_, MicLock>,
    whisper: tauri::State<'_, WhisperServer>,
    device_name: Option<String>,
) -> Result<u32, String> {
    if !matches!(whisper.get_status().await, WhisperStatus::Ready) {
        return Err("Speech recognition is not ready".into());
    }
    if listener.active.lock_or_recover().is_some() {
        return Err("Already listening".into());
    }
    let guard = mic.try_take(MicUser::Listening)?;

    let (tx, rx) = sync_channel::<Vec<f32>>(CHUNK_QUEUE);
    let device_failed = Arc::new(AtomicBool::new(false));
    let failed = device_failed.clone();
    let mut last_drop_warn: Option<Instant> = None;
    let (stream, native_rate) = open_input_stream(
        device_name.as_deref(),
        move |mono| {
            if let Err(TrySendError::Full(_)) = tx.try_send(mono.to_vec()) {
                if last_drop_warn.is_none_or(|t| t.elapsed() > Duration::from_secs(5)) {
                    warn!("Constant listening is falling behind; dropping mic audio");
                    last_drop_warn = Some(Instant::now());
                }
            }
        },
        move |err| {
            if matches!(
                err.kind(),
                cpal::ErrorKind::DeviceNotAvailable | cpal::ErrorKind::HostUnavailable
            ) {
                failed.store(true, Ordering::SeqCst);
            }
        },
    )?;

    let session = listener.next_session.fetch_add(1, Ordering::SeqCst);
    let stop = Arc::new(AtomicBool::new(false));
    let hold = Arc::new(AtomicBool::new(false));
    let worker = Worker {
        app: app.clone(),
        session,
        rx,
        native_rate,
        stop: stop.clone(),
        hold: hold.clone(),
        device_failed,
        phrases: spawn_transcriber(app.clone(), session),
    };
    let handle = std::thread::Builder::new()
        .name("voice-listen".into())
        .spawn(move || worker.run())
        .map_err(|e| format!("Couldn't start listening: {e}"))?;

    *listener.active.lock_or_recover() = Some(ActiveListen {
        session,
        stop,
        hold,
        worker: Some(handle),
        _stream: stream,
        _guard: guard,
    });
    info!("Constant listening started (session {session}, {native_rate} Hz)");
    emit(&app, ListenEvent::Started { session });
    Ok(session)
}

/// Stop listening and let the mic go. Does nothing when not listening.
#[tauri::command]
pub async fn voice_listen_stop(
    app: AppHandle,
    listener: tauri::State<'_, VoiceListener>,
) -> Result<(), String> {
    let Some(mut active) = listener.active.lock_or_recover().take() else {
        return Ok(());
    };
    active.stop.store(true, Ordering::SeqCst);
    let session = active.session;
    let worker = active.worker.take();
    drop(active);
    if let Some(worker) = worker {
        let _ = tauri::async_runtime::spawn_blocking(move || worker.join()).await;
    }
    info!("Constant listening stopped by the user");
    emit(
        &app,
        ListenEvent::Stopped {
            session,
            reason: StopReason::User,
        },
    );
    Ok(())
}

/// Hold listening while the page plays audio or video (`true`), or let it
/// carry on (`false`). Read-aloud holds it without this.
#[tauri::command]
pub fn voice_listen_hold(listener: tauri::State<'_, VoiceListener>, hold: bool) {
    if let Some(active) = listener.active.lock_or_recover().as_ref() {
        active.hold.store(hold, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialize_with_a_type_tag() {
        let evt = ListenEvent::Phrase {
            session: 3,
            seq: 2,
            text: "hi".into(),
        };
        assert_eq!(
            serde_json::to_value(&evt).unwrap(),
            serde_json::json!({ "type": "Phrase", "session": 3, "seq": 2, "text": "hi" })
        );
        let stopped = ListenEvent::Stopped {
            session: 1,
            reason: StopReason::Idle,
        };
        assert_eq!(
            serde_json::to_value(&stopped).unwrap()["reason"],
            serde_json::json!("Idle")
        );
    }
}
