mod app_log;
mod audio;
mod clipboard;
mod code_tools;
mod db;
mod feedback;
mod fs_tools;
mod hardware;
mod inference;
mod inference_queue;
mod integrations;
mod links;
mod lint;
mod models;
mod proxy;
mod sandbox_fetch;
mod sandbox_save;
mod sandbox_sync;
mod server;
mod shell;
mod sidecar_utils;
mod text_util;
mod time_util;
mod tts;
mod whisper;

use audio::AudioRecorder;
use db::Database;
use inference_queue::InferenceQueue;
use models::ModelManager;
use proxy::stats::{SearchStats, StatSinkHandle};
use proxy::ProxyState;
use server::LlamaServer;
use shell::ShellManager;
use tauri::{Manager, RunEvent, WindowEvent};
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
        // Custom scheme backing the Python sandbox's synchronous HTTP
        // (requests / urllib via pyodide-http's XMLHttpRequest transport).
        // The worker rewrites cross-origin XHRs onto this scheme; the
        // handler fetches via reqwest (no browser CORS). See sandbox_fetch.
        .register_asynchronous_uri_scheme_protocol("haruspexfetch", |_ctx, request, responder| {
            tauri::async_runtime::spawn(async move {
                responder.respond(sandbox_fetch::handle_fetch_scheme(request).await);
            });
        })
        .setup(|app| {
            app.manage(ModelManager::new(app.handle()));
            let database = Database::new(app.handle()).expect("Failed to initialize database");
            // The proxy records search stats through the StatSink trait
            // (audit A3); Database is a cloneable handle to one shared
            // connection, so both managed states hit the same SQLite file.
            app.manage(StatSinkHandle(std::sync::Arc::new(database.clone())));
            app.manage(database);

            // Initialize PDFium for high-quality PDF text extraction.
            // Falls back to pdf-extract if the bundled libpdfium is missing.
            if let Ok(resource_dir) = app.path().resource_dir() {
                fs_tools::init_pdfium(&resource_dir);
            }

            // Backstop reclaim of inference slots whose holder window hung
            // without releasing or heartbeating.
            inference_queue::spawn_lease_sweeper(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            // Primary orphan cleanup: a window that closes (or crashes)
            // forfeits any inference slots/tickets it held, so a detached
            // shell window dying mid-turn can't deadlock the single slot.
            if let WindowEvent::Destroyed = event {
                let queue = window.state::<InferenceQueue>();
                queue.on_window_destroyed(window.app_handle(), window.label());
            }
        })
        .manage(LlamaServer::new())
        .manage(InferenceQueue::new())
        .manage(ProxyState::new())
        .manage(SearchStats::new())
        .manage(AudioRecorder::new())
        .manage(WhisperServer::new())
        .manage(TtsEngine::new())
        .manage(ShellManager::new())
        .invoke_handler(tauri::generate_handler![
            server::start_server,
            server::stop_server,
            server::get_server_status,
            server::get_server_logs,
            server::clear_server_logs,
            server::get_cpu_fallback_state,
            server::get_llama_crash_log,
            server::get_llama_crash_log_path,
            server::clear_llama_crash_log,
            models::list_models,
            models::download_model,
            models::cancel_download,
            hardware::cmd_detect_hardware,
            models::import_model,
            models::get_models_dir,
            models::has_any_model,
            models::get_active_model_path,
            models::delete_model,
            models::get_whisper_model_path,
            models::download_whisper_model,
            proxy::proxy_search,
            proxy::proxy_fetch,
            proxy::get_search_stats,
            proxy::reset_lifetime_search_stats,
            proxy::images::proxy_image_search,
            proxy::images::proxy_fetch_url_images,
            inference::probe_inference_server,
            inference_queue::inference_acquire,
            inference_queue::inference_cancel,
            inference_queue::inference_release,
            inference_queue::inference_heartbeat,
            inference_queue::inference_queue_snapshot,
            audio::start_recording,
            audio::stop_recording,
            audio::is_recording,
            audio::list_audio_input_devices,
            audio::list_audio_output_devices,
            whisper::start_whisper,
            whisper::stop_whisper,
            whisper::get_whisper_status,
            whisper::get_whisper_logs,
            whisper::clear_whisper_logs,
            whisper::transcribe_audio,
            tts::tts_initialize,
            tts::tts_synthesize_and_play,
            tts::tts_stop_playback,
            tts::tts_is_playing,
            tts::tts_list_voices,
            tts::tts_is_initialized,
            tts::get_tts_logs,
            tts::clear_tts_logs,
            db::db_list_conversations,
            db::db_get_conversation,
            db::db_create_conversation,
            db::db_save_message,
            db::db_update_last_message_steps,
            db::db_rename_conversation,
            db::db_delete_conversation,
            db::db_clear_all_conversations,
            db::db_replace_messages,
            db::db_create_job,
            db::db_list_jobs,
            db::db_get_job,
            db::db_update_job,
            db::db_delete_job,
            db::db_replace_job_steps,
            db::db_create_job_run,
            db::db_mark_run_started,
            db::db_mark_run_finished,
            db::db_mark_run_step_started,
            db::db_mark_run_step_finished,
            db::db_list_job_runs,
            db::db_get_job_run,
            db::db_recover_orphan_runs,
            db::db_delete_job_run,
            db::db_delete_all_job_runs,
            db::db_set_job_next_due_at,
            db::db_list_due_jobs,
            fs_tools::absolute::fs_read_text_absolute,
            fs_tools::absolute::fs_list_dir_absolute,
            fs_tools::absolute::fs_read_pdf_absolute,
            fs_tools::absolute::fs_write_text_absolute,
            fs_tools::absolute::fs_edit_text_absolute,
            fs_tools::path::fs_list_dir,
            fs_tools::text::fs_read_text,
            fs_tools::text::fs_write_text,
            fs_tools::text::fs_edit_text,
            code_tools::run_command_capture,
            code_tools::run_command_cancel,
            code_tools::code_write_overflow,
            code_tools::code_grep,
            code_tools::code_glob,
            fs_tools::pdf_read::fs_read_pdf,
            fs_tools::docx::fs_read_docx,
            fs_tools::xlsx::fs_read_xlsx,
            fs_tools::images::fs_read_image,
            fs_tools::pdf_read::fs_read_pdf_bytes,
            fs_tools::docx::fs_write_docx,
            fs_tools::xlsx::fs_write_xlsx,
            fs_tools::pdf_write::fs_write_pdf,
            fs_tools::odt::fs_write_odt,
            fs_tools::xlsx::fs_write_ods,
            fs_tools::pptx::fs_write_pptx,
            fs_tools::odp::fs_write_odp,
            fs_tools::download::fs_download_url,
            fs_tools::path::fs_path_exists,
            fs_tools::path::fs_find_available_path,
            lint::fs_lint_python,
            lint::lint_python_source,
            sandbox_fetch::sandbox_fetch,
            sandbox_save::sandbox_save,
            sandbox_save::sandbox_delete_in_workdir,
            sandbox_sync::sandbox_sync_workdir,
            integrations::email::commands::email_list_providers,
            integrations::email::commands::email_test_connection,
            integrations::email::commands::email_list_recent,
            integrations::email::commands::email_read_full,
            integrations::email::commands::email_prepare_summary,
            app_log::get_app_logs,
            app_log::clear_app_logs,
            links::open_url,
            feedback::get_diagnostics,
            feedback::save_diagnostics_file,
            shell::shell_spawn,
            shell::shell_write,
            shell::shell_mark_ready,
            shell::shell_resize,
            shell::shell_kill,
            shell::shell_restart,
            shell::shell_get_context,
            shell::shell_get_last_command,
            shell::shell_get_recent_commands,
            shell::shell_get_recent_history,
            shell::shell_get_scrollback,
            shell::shell_stash_chat,
            shell::shell_take_chat,
            shell::shell_stash_scrollback,
            shell::shell_take_scrollback,
            shell::shell_platform_supported,
            clipboard::clipboard_read_text,
            clipboard::clipboard_read_primary,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let llama = app.state::<LlamaServer>();
                let whisper = app.state::<WhisperServer>();
                let tts = app.state::<TtsEngine>();
                let shell_mgr = app.state::<ShellManager>();
                shell_mgr.shutdown_all();
                tauri::async_runtime::block_on(async {
                    let _ = llama.stop().await;
                    let _ = whisper.stop().await;
                    let _ = tts.stop().await;
                });
            }
        });
}
