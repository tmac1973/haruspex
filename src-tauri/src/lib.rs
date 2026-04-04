mod audio;
mod db;
mod models;
mod proxy;
mod server;
mod tts;
mod whisper;

use audio::AudioRecorder;
use db::Database;
use models::ModelManager;
use proxy::ProxyState;
use server::LlamaServer;
use tauri::{Manager, RunEvent};
use tts::TtsEngine;
use whisper::WhisperServer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.manage(ModelManager::new(app.handle()));
            app.manage(Database::new(app.handle()).expect("Failed to initialize database"));
            Ok(())
        })
        .manage(LlamaServer::new())
        .manage(ProxyState::new())
        .manage(AudioRecorder::new())
        .manage(WhisperServer::new())
        .manage(TtsEngine::new())
        .invoke_handler(tauri::generate_handler![
            server::start_server,
            server::stop_server,
            server::get_server_status,
            server::get_server_logs,
            models::list_models,
            models::download_model,
            models::cancel_download,
            models::cmd_detect_hardware,
            models::import_model,
            models::get_models_dir,
            models::has_any_model,
            models::get_active_model_path,
            models::delete_model,
            models::get_whisper_model_path,
            models::download_whisper_model,
            proxy::proxy_search,
            proxy::proxy_fetch,
            audio::start_recording,
            audio::stop_recording,
            audio::is_recording,
            whisper::start_whisper,
            whisper::stop_whisper,
            whisper::get_whisper_status,
            whisper::transcribe_audio,
            tts::tts_initialize,
            tts::tts_synthesize_and_play,
            tts::tts_stop_playback,
            tts::tts_is_playing,
            tts::tts_list_voices,
            tts::tts_is_initialized,
            db::db_list_conversations,
            db::db_get_conversation,
            db::db_create_conversation,
            db::db_save_message,
            db::db_rename_conversation,
            db::db_delete_conversation,
            db::db_clear_all_conversations,
            db::db_replace_messages,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let llama = app.state::<LlamaServer>();
                let whisper = app.state::<WhisperServer>();
                let tts = app.state::<TtsEngine>();
                tauri::async_runtime::block_on(async {
                    let _ = llama.stop().await;
                    let _ = whisper.stop().await;
                    let _ = tts.stop().await;
                });
            }
        });
}
