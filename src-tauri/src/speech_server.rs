//! A llama.cpp speech engine: any llama-server (v0.8.0 or newer) that serves
//! `/tts`, reached directly or through llama-toolchest. Settings → Audio →
//! Speech engine picks it; Kokoro stays the default and reads answers aloud.
//!
//! Without a voice the request is JSON. With a saved voice (`voices.rs`) it
//! is multipart: the reference clip as `speaker_ref`, and what it says as
//! `speaker_ref_text`, which makes Qwen3-TTS continue from the clip and copy
//! the voice more closely. A server too old for `speaker_ref_text` answers
//! 400; the request goes again without it, and the note says why. `speed` is
//! never sent (Qwen3-TTS refuses anything but 1.0): `audio_stretch` changes
//! the pace after. The WAV goes in the audio cache like Kokoro's, under the
//! SHA-256 of its bytes, which tells two takes apart.
//!
//! Like the other toolchest calls, the webview resolves the named key and
//! sends it inline.

use crate::db::Database;
use serde::Serialize;
use std::time::Duration;
use tauri::AppHandle;

/// A long narration takes minutes on a small GPU.
const TTS_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// What one `/tts` request carries.
#[derive(Clone, Debug, Default)]
pub struct TtsRequest {
    pub model: String,
    pub text: String,
    /// The reference clip's WAV, and what it says (empty when unknown).
    pub reference: Option<(Vec<u8>, String)>,
    pub seed: Option<u64>,
    pub temperature: Option<f32>,
}

/// One take: its WAV, and a note for the caller when something was dropped.
#[derive(Debug)]
pub struct Take {
    pub wav: Vec<u8>,
    pub note: Option<String>,
}

const OLD_SERVER: &str = "The speech server has no /tts: it needs llama.cpp v0.8.0 or newer.";
const NO_REF_TEXT: &str = "The server refused the reference clip's words, so the voice was \
     copied from the sound alone. Closer copies need llama.cpp b12491 or newer and a projector \
     with the reference encoder (llama-toolchest's Get speech models card has one).";

fn form(req: &TtsRequest, with_text: bool) -> Option<reqwest::multipart::Form> {
    let (wav, ref_text) = req.reference.as_ref()?;
    let part = reqwest::multipart::Part::bytes(wav.clone())
        .file_name("reference.wav")
        .mime_str("audio/wav")
        .ok()?;
    let mut f = reqwest::multipart::Form::new()
        .text("model", req.model.clone())
        .text("input", req.text.clone())
        .part("speaker_ref", part);
    if with_text && !ref_text.trim().is_empty() {
        f = f.text("speaker_ref_text", ref_text.trim().to_string());
    }
    if let Some(seed) = req.seed {
        f = f.text("seed", seed.to_string());
    }
    if let Some(t) = req.temperature {
        f = f.text("temperature", t.to_string());
    }
    Some(f)
}

fn json(req: &TtsRequest) -> serde_json::Value {
    let mut body = serde_json::json!({ "model": req.model, "input": req.text });
    if let Some(seed) = req.seed {
        body["seed"] = seed.into();
    }
    if let Some(t) = req.temperature {
        body["temperature"] = f64::from(t).into();
    }
    body
}

/// The server's own words from an error body, else the status.
fn error_of(status: reqwest::StatusCode, body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    format!(
        "The speech server answered {}: {}",
        status.as_u16(),
        msg.trim()
    )
}

async fn send(
    base: &str,
    api_key: Option<&str>,
    req: &TtsRequest,
    with_text: bool,
) -> Result<Result<Vec<u8>, (reqwest::StatusCode, String)>, String> {
    let url = format!("{}/tts", base.trim().trim_end_matches('/'));
    let mut builder = crate::comfy::lan_client().post(&url).timeout(TTS_TIMEOUT);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        builder = builder.bearer_auth(key);
    }
    builder = match form(req, with_text) {
        Some(f) => builder.multipart(f),
        None => builder.json(&json(req)),
    };
    let resp = builder
        .send()
        .await
        .map_err(|e| format!("Can't reach the speech server: {e}"))?;
    let status = resp.status();
    if status.is_success() {
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("The speech server's answer broke off: {e}"))?;
        return Ok(Ok(bytes.to_vec()));
    }
    Ok(Err((status, resp.text().await.unwrap_or_default())))
}

/// Speak `req` on the server at `base`.
pub async fn synthesize(
    base: &str,
    api_key: Option<&str>,
    req: &TtsRequest,
) -> Result<Take, String> {
    let has_text = req
        .reference
        .as_ref()
        .is_some_and(|(_, t)| !t.trim().is_empty());
    let mut note = None;
    let mut answer = send(base, api_key, req, true).await?;
    if has_text && matches!(&answer, Err((s, _)) if s.as_u16() == 400) {
        answer = send(base, api_key, req, false).await?;
        note = Some(NO_REF_TEXT.to_string());
    }
    match answer {
        Ok(wav) => Ok(Take {
            wav: fix_wav(wav)?,
            note,
        }),
        Err((s, _)) if s.as_u16() == 404 => Err(OLD_SERVER.into()),
        Err((s, body)) => Err(error_of(s, &body)),
    }
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// A WAV whose sizes match its bytes: a streamed answer may leave them as
/// placeholders. Errors when it is not a PCM WAV at all.
pub fn fix_wav(mut wav: Vec<u8>) -> Result<Vec<u8>, String> {
    if wav.len() < 12 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err("The speech server did not send a WAV.".into());
    }
    crate::audio::wav_fix_sizes(&mut wav).ok_or("The speech server's WAV has no sound in it.")?;
    Ok(wav)
}

/// A PCM WAV's length in seconds.
pub fn wav_seconds(wav: &[u8]) -> f64 {
    let mut at = 12;
    let (mut rate, mut block) = (0u32, 0u32);
    while at + 8 <= wav.len() {
        let size = u32_at(wav, at + 4).unwrap_or(0);
        match &wav[at..at + 4] {
            b"fmt " => {
                rate = u32_at(wav, at + 12).unwrap_or(0);
                block = wav
                    .get(at + 20..at + 22)
                    .map_or(0, |s| u16::from_le_bytes([s[0], s[1]]) as u32);
            }
            b"data" if rate > 0 && block > 0 => {
                return f64::from(size) / f64::from(rate * block);
            }
            _ => {}
        }
        at += 8 + size as usize + (size as usize & 1);
    }
    0.0
}

/// One take in the audio cache.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ServerSpeech {
    /// The SHA-256 of the WAV: its name in the audio cache.
    pub hash: String,
    pub mime: String,
    #[ts(type = "number")]
    pub bytes: u64,
    pub seconds: f64,
    /// Said when the request had to drop something.
    pub note: Option<String>,
}

/// Speak `text` on a llama.cpp `/tts` server, in the saved voice `voice`
/// (its name or id) when given, into the audio cache.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn speech_server_synthesize(
    app: AppHandle,
    db: tauri::State<'_, Database>,
    base_url: String,
    api_key: Option<String>,
    model: String,
    text: String,
    voice: Option<String>,
    seed: Option<u64>,
    temperature: Option<f32>,
    title: Option<String>,
    conversation_id: Option<String>,
    code_session_id: Option<String>,
) -> Result<ServerSpeech, String> {
    if base_url.trim().is_empty() {
        return Err("No speech server is set — Settings → Audio → Speech engine.".into());
    }
    let reference = match voice.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        None => None,
        Some(name) => {
            let root = crate::voices::root(&app)?;
            let saved = crate::voices::find(&root, name).ok_or_else(|| {
                let names: Vec<String> = crate::voices::list(&root)
                    .into_iter()
                    .map(|v| v.name)
                    .collect();
                if names.is_empty() {
                    format!("There is no saved voice called {name}; none are saved yet (Settings → Audio → Saved voices).")
                } else {
                    format!(
                        "There is no saved voice called {name}. Saved: {}.",
                        names.join(", ")
                    )
                }
            })?;
            let wav = std::fs::read(crate::voices::reference_path(&root, &saved.id)?)
                .map_err(|e| format!("Can't read the voice {}: {e}", saved.name))?;
            Some((wav, saved.ref_text))
        }
    };
    let req = TtsRequest {
        model: model.trim().to_string(),
        text,
        reference,
        seed,
        temperature,
    };
    let take = synthesize(&base_url, api_key.as_deref(), &req).await?;
    let seconds = wav_seconds(&take.wav);
    let dir = crate::audio_cache::cache_dir(&app)?;
    let temp = dir.join(crate::audio_cache::commands::temp_name());
    std::fs::write(&temp, &take.wav).map_err(|e| format!("Can't keep the audio: {e}"))?;
    let stored = crate::audio_cache::commands::store_file(
        &db,
        &dir,
        &temp,
        "audio/wav",
        title,
        Some((seconds * 1000.0).round() as i64),
        conversation_id.as_deref(),
        code_session_id.as_deref(),
    )
    .await?;
    Ok(ServerSpeech {
        hash: stored.hash,
        mime: stored.mime,
        bytes: stored.bytes,
        seconds,
        note: take.note,
    })
}

/// The models on a server that speak. llama-toolchest marks them with the
/// `speech` capability; a plain llama-server lists only the one it runs.
pub fn speech_models(json: &serde_json::Value) -> Vec<String> {
    let data = json
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let tagged = data
        .iter()
        .any(|m| m.pointer("/meta/capabilities").is_some());
    data.iter()
        .filter(|m| {
            !tagged
                || m.pointer("/meta/capabilities")
                    .and_then(|c| c.as_array())
                    .is_some_and(|c| c.iter().any(|x| x == "speech"))
        })
        .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(str::to_string))
        .collect()
}

#[tauri::command]
pub async fn speech_server_models(
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    let url = format!("{}/v1/models", base_url.trim().trim_end_matches('/'));
    let mut builder = crate::comfy::lan_client()
        .get(&url)
        .timeout(Duration::from_secs(15));
    if let Some(key) = api_key.as_deref().filter(|k| !k.is_empty()) {
        builder = builder.bearer_auth(key);
    }
    let resp = builder
        .send()
        .await
        .map_err(|e| format!("Can't reach {}: {e}", base_url.trim()))?;
    if resp.status().as_u16() == 401 {
        return Err("Wrong or missing API key.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("{} answered {}.", base_url.trim(), resp.status()));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("{} sent no model list: {e}", base_url.trim()))?;
    Ok(speech_models(&json))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, StatusCode};
    use std::sync::{Arc, Mutex};

    /// A WAV of `secs` of 16-bit mono at 24 kHz, its sizes as `data_size` says.
    fn wav(secs: f64, data_size: Option<u32>) -> Vec<u8> {
        let n = (secs * 24_000.0) as u32 * 2;
        let mut b = b"RIFF".to_vec();
        b.extend((36 + n).to_le_bytes());
        b.extend(b"WAVEfmt ");
        b.extend(16u32.to_le_bytes());
        b.extend(1u16.to_le_bytes());
        b.extend(1u16.to_le_bytes());
        b.extend(24_000u32.to_le_bytes());
        b.extend(48_000u32.to_le_bytes());
        b.extend(2u16.to_le_bytes());
        b.extend(16u16.to_le_bytes());
        b.extend(b"data");
        b.extend(data_size.unwrap_or(n).to_le_bytes());
        b.extend(vec![0u8; n as usize]);
        b
    }

    /// Each request the fake saw: its content type and body.
    type Seen = Arc<Mutex<Vec<(String, String)>>>;

    /// A `/tts` that answers each request with the next status in `answers`
    /// (200 sends a WAV), recording what it was sent.
    async fn serve(answers: Vec<u16>) -> (String, Seen) {
        let seen: Seen = Arc::default();
        let queue = Arc::new(Mutex::new(answers));
        let s = seen.clone();
        let app = axum::Router::new().route(
            "/tts",
            axum::routing::post(move |headers: HeaderMap, body: axum::body::Bytes| {
                let (s, queue) = (s.clone(), queue.clone());
                async move {
                    let kind = headers
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    s.lock()
                        .unwrap()
                        .push((kind, String::from_utf8_lossy(&body).into_owned()));
                    let code = queue.lock().unwrap().remove(0);
                    if code == 200 {
                        (StatusCode::OK, wav(1.0, Some(u32::MAX)))
                    } else {
                        let msg = br#"{"error":{"code":400,"message":"bad field"}}"#.to_vec();
                        (StatusCode::from_u16(code).unwrap(), msg)
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, seen)
    }

    fn req(reference: Option<(Vec<u8>, String)>) -> TtsRequest {
        TtsRequest {
            model: "qwen3-tts".into(),
            text: "Hello there.".into(),
            reference,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn without_a_voice_it_sends_json_and_never_speed() {
        let (base, seen) = serve(vec![200]).await;
        let take = synthesize(&base, None, &req(None)).await.unwrap();
        assert!(take.note.is_none());
        assert!((wav_seconds(&take.wav) - 1.0).abs() < 1e-6);
        let (kind, body) = seen.lock().unwrap()[0].clone();
        assert!(kind.starts_with("application/json"), "{kind}");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"model": "qwen3-tts", "input": "Hello there."})
        );
    }

    #[tokio::test]
    async fn a_voice_goes_as_speaker_ref_with_its_text_and_seed() {
        let (base, seen) = serve(vec![200]).await;
        let mut r = req(Some((b"REFWAV".to_vec(), "the quick fox".into())));
        r.seed = Some(7);
        synthesize(&base, Some("k"), &r).await.unwrap();
        let (kind, body) = seen.lock().unwrap()[0].clone();
        assert!(kind.starts_with("multipart/form-data"), "{kind}");
        assert!(body.contains("name=\"speaker_ref\""));
        assert!(body.contains("REFWAV"));
        assert!(body.contains("name=\"speaker_ref_text\"\r\n\r\nthe quick fox"));
        assert!(body.contains("name=\"seed\"\r\n\r\n7"));
        assert!(!body.contains("speed"));
        assert!(!body.contains("temperature"));
    }

    #[tokio::test]
    async fn a_400_with_ref_text_goes_again_without_it() {
        let (base, seen) = serve(vec![400, 200]).await;
        let take = synthesize(&base, None, &req(Some((b"W".to_vec(), "words".into()))))
            .await
            .unwrap();
        assert!(take.note.unwrap().contains("b12491"));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].1.contains("speaker_ref_text"));
        assert!(!seen[1].1.contains("speaker_ref_text"));
        assert!(seen[1].1.contains("speaker_ref"));
    }

    #[tokio::test]
    async fn a_400_without_ref_text_and_a_404_are_errors() {
        let (base, seen) = serve(vec![400]).await;
        let err = synthesize(&base, None, &req(None)).await.unwrap_err();
        assert_eq!(err, "The speech server answered 400: bad field");
        assert_eq!(seen.lock().unwrap().len(), 1);
        let (base, _) = serve(vec![404]).await;
        let err = synthesize(&base, None, &req(None)).await.unwrap_err();
        assert!(err.contains("v0.8.0"));
    }

    #[test]
    fn a_streamed_wavs_sizes_are_fixed() {
        let fixed = fix_wav(wav(2.0, Some(u32::MAX))).unwrap();
        assert!((wav_seconds(&fixed) - 2.0).abs() < 1e-6);
        assert_eq!(u32_at(&fixed, 4).unwrap() as usize, fixed.len() - 8);
        assert!(fix_wav(b"{\"error\":1}".to_vec()).is_err());
    }

    #[test]
    fn speech_models_are_the_tagged_ones_or_all_of_a_plain_server() {
        let toolchest = serde_json::json!({"data": [
            {"id": "chat", "meta": {"capabilities": ["chat"]}},
            {"id": "qwen3-tts", "meta": {"capabilities": ["speech"]}},
            {"id": "ti2v", "meta": {"kind": "video"}}
        ]});
        assert_eq!(speech_models(&toolchest), ["qwen3-tts"]);
        let plain = serde_json::json!({"data": [{"id": "model.gguf"}]});
        assert_eq!(speech_models(&plain), ["model.gguf"]);
    }

    /// `HARUSPEX_TTS_URL=http://asmodean:3000 HARUSPEX_TTS_MODEL=… cargo test -- --ignored real_tts --nocapture`
    #[tokio::test]
    #[ignore = "needs a llama.cpp /tts server"]
    async fn real_tts_server_speaks() {
        let base = std::env::var("HARUSPEX_TTS_URL").expect("set HARUSPEX_TTS_URL");
        let model = std::env::var("HARUSPEX_TTS_MODEL").expect("set HARUSPEX_TTS_MODEL");
        let r = TtsRequest {
            model,
            text: "This is a test.".into(),
            ..Default::default()
        };
        let take = synthesize(&base, None, &r).await.unwrap();
        let secs = wav_seconds(&take.wav);
        println!("{secs:.2} s");
        assert!(secs > 0.5 && secs < 10.0);
    }
}
