mod app_log;
mod audio;
mod db;
mod fs_tools;
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
    // Install our in-memory logger first so any logging during setup is
    // captured for the Log Viewer. The Tauri log plugin in debug builds
    // would clash with this, so we replace it.
    app_log::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(ModelManager::new(app.handle()));
            app.manage(Database::new(app.handle()).expect("Failed to initialize database"));

            // Initialize PDFium for high-quality PDF text extraction.
            // Falls back to pdf-extract if the bundled libpdfium is missing.
            if let Ok(resource_dir) = app.path().resource_dir() {
                fs_tools::init_pdfium(&resource_dir);
            }

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
            audio::list_audio_input_devices,
            audio::list_audio_output_devices,
            whisper::start_whisper,
            whisper::stop_whisper,
            whisper::get_whisper_status,
            whisper::get_whisper_logs,
            whisper::transcribe_audio,
            tts::tts_initialize,
            tts::tts_synthesize_and_play,
            tts::tts_stop_playback,
            tts::tts_is_playing,
            tts::tts_list_voices,
            tts::tts_is_initialized,
            tts::get_tts_logs,
            db::db_list_conversations,
            db::db_get_conversation,
            db::db_create_conversation,
            db::db_save_message,
            db::db_rename_conversation,
            db::db_delete_conversation,
            db::db_clear_all_conversations,
            db::db_replace_messages,
            fs_tools::fs_list_dir,
            fs_tools::fs_read_text,
            fs_tools::fs_write_text,
            fs_tools::fs_edit_text,
            fs_tools::fs_read_pdf,
            fs_tools::fs_read_docx,
            fs_tools::fs_read_xlsx,
            fs_tools::fs_read_image,
            fs_tools::fs_read_pdf_bytes,
            fs_tools::fs_write_docx,
            fs_tools::fs_write_xlsx,
            fs_tools::fs_write_pdf,
            app_log::get_app_logs,
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
