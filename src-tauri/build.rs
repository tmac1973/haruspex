fn main() {
    // espeak-rs-sys needs sonic and pcaudiolib for audio output
    #[cfg(target_os = "linux")]
    {
        println!("cargo:rustc-link-lib=sonic");
        println!("cargo:rustc-link-lib=pcaudio");
    }

    tauri_build::build()
}
