mod app_log;
mod artifact_frame;
mod audio;
mod clipboard;
mod code_tools;
mod comfy;
mod comfy_models;
mod command_scope;
mod db;
mod desktop;
mod env_util;
mod feedback;
mod fs_tools;
mod hardware;
mod image_cache;
mod image_engine;
mod image_gen;
mod image_models;
mod inference;
mod inference_queue;
mod integrations;
mod links;
mod lint;
mod memory;
mod models;
mod orphans;
mod power;
mod proxy;
mod remote;
mod runtimes;
mod sandbox_fetch;
mod sandbox_save;
mod sandbox_sync;
mod secrets;
mod server;
mod shell;
mod sidecar_process;
mod sidecar_utils;
mod skills;
mod sync_util;
mod text_util;
mod time_util;
mod tts;
mod whisper;

use audio::AudioRecorder;
use db::Database;
use inference_queue::InferenceQueue;
use integrations::mcp::{McpInstaller, McpSupervisor};
use models::ModelManager;
use power::PowerInhibitor;
use proxy::stats::{SearchStats, StatSinkHandle};
use proxy::ProxyState;
use remote::RemoteServer;
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
        .plugin(tauri_plugin_notification::init())
        .plugin(image_cache::protocol::webview_plugin())
        // Custom scheme backing the Python sandbox's synchronous HTTP
        // (requests / urllib via pyodide-http's XMLHttpRequest transport).
        // The worker rewrites cross-origin XHRs onto this scheme; the
        // handler fetches via reqwest (no browser CORS). See sandbox_fetch.
        .register_asynchronous_uri_scheme_protocol("haruspexfetch", |ctx, request, responder| {
            let net = ctx
                .app_handle()
                .state::<sandbox_fetch::SandboxNet>()
                .current();
            tauri::async_runtime::spawn(async move {
                responder.respond(sandbox_fetch::handle_fetch_scheme(request, net).await);
            });
        })
        // Serves cached chat images by content hash. Registered as a scheme
        // rather than handed over IPC as data: URLs so a long conversation's
        // images stream from disk instead of sitting in webview memory. See
        // image_cache::protocol for the URL shape and why the hash is in the
        // path rather than the host.
        // Interactive Python artifacts, each served with a CSP of its own so
        // the app window's can stay strict. See artifact_frame.
        .register_uri_scheme_protocol("haruspex-artifact", |ctx, request| {
            ctx.app_handle()
                .state::<artifact_frame::ArtifactFrames>()
                .handle(&request)
        })
        .register_asynchronous_uri_scheme_protocol("haruspex-img", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(image_cache::protocol::handle(&app, request));
            });
        })
        .setup(|app| {
            // A failure here ends startup with the reason in the log, rather
            // than a panic backtrace.
            if let Ok(dir) = app.path().app_data_dir() {
                secrets::init(dir);
            }
            app.manage(ModelManager::new(app.handle())?);
            // Files open in editor windows; nothing is watched until one opens.
            app.manage(fs_tools::editor::editor_watches(app.handle()));
            let database = Database::new(app.handle())
                .map_err(|e| format!("Failed to initialize database: {e}"))?;
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

            // The skills Haruspex ships, copied into the user's skills folder
            // before any window lists skills. See skills::shipped.
            skills::seed_shipped(app.handle());

            // Reap MCP servers left running by a previous launch that never
            // got to clean up (SIGKILL, a crash, a hard power-off). Must run
            // before anything spawns, so a fresh pid is never mistaken for a
            // stale one. See integrations::mcp::orphans.
            orphans::sweep(app.handle(), orphans::MCP);
            // The same for the sidecars: an orphaned image engine otherwise
            // holds its VRAM until the next image is asked for.
            orphans::sweep(app.handle(), orphans::SIDECARS);
            // The coding tools' background processes: kill what a crash left
            // running, then hold the registry for this run.
            {
                use code_tools::background::{self, CodeBgManager};
                let log_dir = app
                    .path()
                    .app_cache_dir()
                    .unwrap_or_else(|_| std::env::temp_dir().join("haruspex"))
                    .join("code-bg");
                let registry = orphans::registry_path(app.handle(), background::ORPHAN_KIND).ok();
                background::sweep_orphans(&log_dir, registry.as_deref());
                app.manage(CodeBgManager::new(log_dir, registry));
            }
            // The supervisor holds the orphan-registry path rather than an
            // AppHandle, which is what lets it be driven in tests; resolving it
            // needs the handle, so it is managed here rather than in the
            // builder chain.
            app.manage(
                McpSupervisor::new(orphans::registry_path(app.handle(), orphans::MCP).ok())
                    // A server may add or remove tools while it is running — Godot
                    // reveals a whole toolset when the model enables one — and the
                    // frontend registry has to hear about it or the new tools stay
                    // invisible until a restart.
                    .on_tools_changed(integrations::mcp::commands::spawn_tools_changed_bridge(
                        app.handle().clone(),
                    )),
            );

            // Backstop reclaim of inference slots whose holder window hung
            // without releasing or heartbeating.
            inference_queue::spawn_lease_sweeper(app.handle().clone());

            // Reclaim cached images no conversation references any more.
            // Deleting a conversation cascades its `conversation_images` rows
            // away but cannot free the bytes — the delete path knows nothing
            // about the cache directory — so the sweep collects them here, on
            // the next launch. Off the main thread: it touches the filesystem
            // and must never delay the window appearing.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let db = handle.state::<Database>();
                    match image_cache::cache_dir(&handle) {
                        Ok(dir) => {
                            if let Err(e) = image_cache::sweep_orphans(&db, &dir) {
                                log::warn!("image cache sweep failed: {}", e);
                            }
                        }
                        Err(e) => log::warn!("image cache dir unavailable: {}", e),
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Primary orphan cleanup: a window that closes (or crashes)
            // forfeits any inference slots/tickets it held, so a detached
            // shell window dying mid-turn can't deadlock the single slot.
            if let WindowEvent::Destroyed = event {
                let queue = window.state::<InferenceQueue>();
                queue.on_window_destroyed(window.app_handle(), window.label());
                // An editor window's files stop being watched with it.
                if let Some(watches) = window.try_state::<fs_tools::editor::EditorWatches>() {
                    watches.unwatch_label(window.label());
                }
                // The rest is for the main window only: a detached shell or an
                // editor window closing is not the app quitting.
                if window.label() != "main" {
                    return;
                }
                // Editor windows go with the main window. `close` (not
                // `destroy`) so a window with unsaved edits asks first.
                for (label, w) in window.app_handle().webview_windows() {
                    if label.starts_with("editor-") {
                        let _ = w.close();
                    }
                }
                // Closing the window is one quit path; RunEvent::Exit below is
                // the other, and neither covers the rest on its own. stop is
                // idempotent, so running both is harmless. Spawned rather than
                // blocked on: this handler runs on the event loop, and a stop
                // can take seconds against a server that ignores its stdin.
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<McpSupervisor>().stop_all().await;
                });
            }
        })
        .manage(LlamaServer::new())
        .manage(sandbox_fetch::SandboxNet::default())
        .manage(artifact_frame::ArtifactFrames::default())
        // Nothing starts here: the image engine spawns on demand only.
        .manage(image_engine::ImageEngine::new())
        .manage(McpInstaller::new())
        .manage(InferenceQueue::new())
        .manage(ProxyState::new())
        // Remote web chat's server: off until Settings turns it on.
        .manage(RemoteServer::new())
        // One browser for the app's life: launched on demand by
        // browser-assisted search and dropped when idle, so nothing is
        // running unless that mode is in use.
        .manage(proxy::browser_session())
        .manage(SearchStats::new())
        .manage(AudioRecorder::new())
        .manage(WhisperServer::new())
        .manage(TtsEngine::new())
        .manage(ShellManager::new())
        // Holds off OS idle-sleep while a job run is in flight. Idle until
        // the runner asks; see power.rs.
        .manage(PowerInhibitor::new())
        .invoke_handler(tauri::generate_handler![
            server::start_server,
            server::stop_server,
            server::get_server_status,
            server::get_server_logs,
            server::clear_server_logs,
            server::get_cpu_fallback_state,
            server::get_llama_api_key,
            server::get_llama_crash_log,
            server::clear_llama_crash_log,
            models::list_models,
            models::recommended_context_size,
            models::context_fit_ceiling,
            models::download_model,
            models::cancel_download,
            models::download_status,
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
            proxy::detect_browser,
            remote::remote_start,
            remote::remote_stop,
            remote::remote_status,
            remote::remote_lan_address,
            remote::remote_link_qr,
            remote::remote_sessions,
            remote::remote_disconnect,
            remote::remote_turn_delta,
            remote::remote_turn_step,
            remote::remote_turn_question,
            remote::remote_turn_question_cleared,
            remote::remote_turn_running,
            remote::remote_turn_done,
            remote::remote_turn_error,
            proxy::images::proxy_image_search,
            proxy::images::proxy_fetch_url_images,
            image_cache::commands::image_resolve,
            image_cache::commands::image_sweep,
            image_cache::commands::image_store_bytes,
            image_cache::commands::image_rehydrate_local,
            image_gen::commands::image_check,
            image_gen::commands::image_palette_spread,
            image_gen::commands::image_contact_sheet,
            image_gen::commands::image_split_sheet,
            image_gen::commands::image_normalize,
            image_gen::commands::image_extract_palette,
            image_gen::commands::image_effective_profile,
            image_gen::commands::image_default_profile,
            image_gen::commands::image_clear_canvas,
            image_gen::commands::image_seam_inputs,
            image_gen::commands::texture_render,
            image_gen::commands::texture_validate,
            image_gen::commands::image_seam_finish,
            inference::probe_inference_server,
            inference_queue::inference_acquire,
            inference_queue::inference_cancel,
            inference_queue::inference_release,
            inference_queue::inference_release_window,
            inference_queue::inference_heartbeat,
            inference_queue::inference_queue_snapshot,
            audio::start_recording,
            audio::stop_recording,
            audio::list_audio_input_devices,
            audio::list_audio_output_devices,
            whisper::start_whisper,
            whisper::get_whisper_status,
            whisper::get_whisper_logs,
            whisper::clear_whisper_logs,
            whisper::transcribe_audio,
            image_engine::image_engine_start,
            image_engine::image_engine_stop,
            image_engine::image_engine_status,
            image_engine::image_engine_logs,
            image_engine::image_engine_clear_logs,
            image_engine::image_engine_request,
            comfy::comfy_json,
            comfy::comfy_bytes,
            comfy::comfy_cancel,
            comfy::comfy_logs,
            comfy::comfy_clear_logs,
            comfy::comfy_subscribe,
            comfy_models::comfy_model_catalogue,
            comfy_models::comfy_can_install_directly,
            comfy_models::comfy_install_direct,
            image_models::image_models,
            image_models::image_model_recommended,
            image_models::download_image_model,
            image_models::delete_image_model,
            tts::tts_initialize,
            tts::tts_synthesize_and_play,
            tts::tts_stop_playback,
            tts::tts_is_playing,
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
            db::db_save_shell_session,
            db::db_load_shell_session,
            db::db_delete_shell_session,
            db::code_session_list,
            db::code_session_create,
            db::code_session_load,
            db::code_session_save,
            db::code_session_update_meta,
            db::code_session_delete,
            db::code_session_fork,
            db::db_replace_messages,
            db::db_create_job,
            db::db_list_jobs,
            db::db_get_job,
            db::db_update_job,
            db::db_set_job_api_key_ref,
            db::db_delete_job,
            db::db_replace_job_steps,
            db::db_create_prompt,
            db::db_list_prompts,
            db::db_delete_prompt,
            db::db_create_job_run,
            db::db_mark_run_started,
            db::memory_add,
            db::memory_search,
            db::memory_find_similar,
            db::memory_neighbors,
            db::memory_similar_pairs,
            db::memory_merge,
            db::memory_touch,
            db::memory_list,
            db::memory_count,
            db::memory_update,
            db::memory_delete,
            db::memory_delete_all,
            db::memory_model_present,
            db::memory_download_model,
            db::memory_unload_model,
            db::conversation_memory_cursor,
            db::conversation_set_memory_enabled,
            db::conversation_set_memory_extracted_to,
            db::db_set_run_environment,
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
            fs_tools::absolute::fs_write_bytes_absolute,
            fs_tools::absolute::fs_read_bytes_absolute,
            fs_tools::absolute::fs_edit_text_absolute,
            fs_tools::path::fs_list_dir,
            fs_tools::bytes::fs_read_bytes,
            fs_tools::bytes::fs_write_bytes,
            fs_tools::bytes::fs_move_in_workdir,
            fs_tools::text::fs_read_text,
            fs_tools::text::fs_read_text_full,
            fs_tools::text::fs_write_text,
            fs_tools::text::fs_edit_text,
            fs_tools::editor::editor_read_file,
            fs_tools::editor::editor_save_file,
            fs_tools::editor::editor_unwatch_file,
            fs_tools::editor::editor_find_open,
            code_tools::run_command_capture,
            code_tools::run_command_cancel,
            code_tools::code_write_overflow,
            code_tools::app_protected_targets,
            code_tools::search::code_grep,
            code_tools::search::code_glob,
            code_tools::background::code_bg_start,
            code_tools::background::code_bg_status,
            code_tools::background::code_bg_tail,
            code_tools::background::code_bg_stop,
            code_tools::background::code_bg_stop_owner,
            skills::skills_list,
            skills::skill_read,
            skills::skill_read_file,
            skills::skill_draft,
            skills::skill_save,
            skills::agents_md_draft,
            skills::agents_md_save,
            skills::skills_shipped,
            skills::skill_restore_shipped,
            skills::skills_project_root,
            skills::skills_project_info,
            skills::skills_agents_md,
            skills::skill_delete_user,
            skills::skills_user_dir,
            fs_tools::pdf_read::fs_read_pdf,
            fs_tools::docx::fs_read_docx,
            fs_tools::xlsx::fs_read_xlsx,
            fs_tools::images::fs_read_image,
            fs_tools::images::read_dropped_image,
            desktop::screenshot::capture_screen,
            desktop::screenshot::list_capture_windows,
            desktop::screenshot::capture_window,
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
            sandbox_fetch::sandbox_set_network,
            artifact_frame::artifact_register,
            sandbox_save::sandbox_save,
            sandbox_save::sandbox_delete_in_workdir,
            sandbox_sync::sandbox_sync_workdir,
            integrations::email::commands::email_list_providers,
            integrations::email::commands::email_test_connection,
            integrations::email::commands::email_list_recent,
            integrations::email::commands::email_read_full,
            integrations::email::commands::email_prepare_summary,
            integrations::email::commands::email_cancel,
            integrations::email::commands::email_forget_session,
            integrations::email::commands::email_test_smtp,
            integrations::email::commands::email_send,
            integrations::email::commands::email_reply_context,
            secrets::secret_available,
            secrets::secret_store_kind,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            app_log::get_app_logs,
            app_log::clear_app_logs,
            app_log::debug_log_file_path,
            app_log::debug_log_append,
            links::open_url,
            links::open_folder,
            feedback::get_diagnostics,
            feedback::save_export_file,
            shell::shell_spawn,
            shell::shell_write,
            shell::shell_mark_ready,
            shell::shell_resize,
            shell::shell_kill,
            shell::shell_restart,
            shell::shell_memory_status,
            shell::shell_get_context,
            shell::shell_get_recent_commands,
            shell::shell_pending_command,
            shell::shell_output_since,
            shell::shell_integration_hook,
            shell::shell_get_recent_history,
            shell::shell_get_scrollback,
            shell::shell_stash_chat,
            shell::shell_take_chat,
            shell::shell_stash_scrollback,
            shell::shell_take_scrollback,
            shell::shell_platform_supported,
            shell::shell_list_shells,
            clipboard::clipboard_read_text,
            clipboard::clipboard_read_primary,
            power::power_inhibit_acquire,
            power::power_inhibit_release,
            integrations::mcp::commands::mcp_start_server,
            integrations::mcp::commands::mcp_stop_server,
            integrations::mcp::commands::mcp_server_status,
            integrations::mcp::commands::mcp_connection_info,
            integrations::mcp::commands::mcp_list_tools,
            integrations::mcp::commands::mcp_call_tool,
            integrations::mcp::commands::mcp_server_logs,
            integrations::mcp::commands::mcp_clear_server_logs,
            integrations::mcp::commands::mcp_catalog,
            integrations::mcp::commands::mcp_install_server,
            integrations::mcp::commands::mcp_cancel_install,
            integrations::mcp::commands::mcp_uninstall_server,
            integrations::mcp::commands::mcp_server_dir,
            integrations::mcp::commands::mcp_connect_remote_server,
            integrations::mcp::commands::mcp_probe_companion,
            integrations::mcp::commands::mcp_companion_status,
            integrations::mcp::commands::mcp_place_setup_file,
            integrations::mcp::commands::mcp_install_addon,
            integrations::mcp::commands::mcp_run_setup_command,
            runtimes::mcp_runtimes_available,
            integrations::dav::commands::dav_discover_collections,
            integrations::dav::google::google_sign_in_available,
            integrations::dav::google::google_sign_in,
            integrations::dav::google::google_sign_out,
            integrations::dav::commands::dav_search_contacts,
            integrations::dav::commands::dav_get_contact,
            integrations::dav::commands::dav_list_events,
            integrations::dav::commands::dav_search_events,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let llama = app.state::<LlamaServer>();
                let whisper = app.state::<WhisperServer>();
                let tts = app.state::<TtsEngine>();
                let shell_mgr = app.state::<ShellManager>();
                // A headless browser left running holds ~1 GB and a debugging
                // port. Its Drop would handle it, but managed state is not
                // guaranteed to drop at process exit, so it is stopped here
                // alongside the sidecars.
                let browser = app.state::<proxy::BrowserSessionHandle>();
                // Closing the listener matters on exit: a port still bound
                // after the window is gone is the kind of thing that makes the
                // next launch fail to bind.
                app.state::<RemoteServer>().shutdown();
                // Let the machine sleep again if a run was still holding the
                // inhibit when the window closed.
                app.state::<PowerInhibitor>().shutdown();
                shell_mgr.shutdown_all();
                app.state::<fs_tools::editor::EditorWatches>().stop_all();
                // MCP children are the ones most likely to outlive us: there
                // can be several, and they are third-party programs that need
                // not honour a closed stdin.
                let mcp = app.state::<McpSupervisor>();
                tauri::async_runtime::block_on(async {
                    mcp.stop_all().await;
                    let _ = llama.stop().await;
                    let _ = whisper.stop().await;
                    let _ = tts.stop().await;
                    // ~7 GB of VRAM for Ming: left behind, it outlived the app.
                    app.state::<image_engine::ImageEngine>().stop().await;
                    browser.shutdown().await;
                    // Background commands never outlive their session.
                    app.state::<code_tools::background::CodeBgManager>()
                        .stop_all()
                        .await;
                });
            }
        });
}
