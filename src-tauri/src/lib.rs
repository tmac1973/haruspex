mod db;
mod models;
mod proxy;
mod server;

use db::Database;
use models::ModelManager;
use proxy::ProxyState;
use server::LlamaServer;
use tauri::Manager;

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
            proxy::proxy_search,
            proxy::proxy_fetch,
            db::db_list_conversations,
            db::db_get_conversation,
            db::db_create_conversation,
            db::db_save_message,
            db::db_rename_conversation,
            db::db_delete_conversation,
            db::db_clear_all_conversations,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
