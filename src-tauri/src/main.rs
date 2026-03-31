// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Work around WebKitGTK DMA-BUF rendering bugs (blank/corrupted window)
    // on certain GPU/driver combinations. Safe to set unconditionally on Linux.
    #[cfg(target_os = "linux")]
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    app_lib::run();
}
