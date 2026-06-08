// Voyager desktop/mobile shell.
//
// Today this is a thin Tauri wrapper around the SvelteKit SPA. It is the
// intended home for the Rust client security core described in the master plan
// (MLS/OpenMLS protocol state, local encrypted database, attachment crypto,
// OS secure-storage integration). Those land behind `#[tauri::command]`s the
// web layer can call through `$lib/platform`. Keeping that boundary here means
// the UI never imports concrete cryptography.

#[tauri::command]
fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        // Bumped once the native security core is wired up.
        secure_core: false,
    }
}

#[derive(serde::Serialize)]
struct PlatformInfo {
    os: String,
    arch: String,
    secure_core: bool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![platform_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
