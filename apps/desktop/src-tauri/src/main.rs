// Prevents an extra console window on Windows in release builds. Do NOT remove.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Thin binary entrypoint per the Tauri 2 standard layout: all real wiring lives
// in the library crate (`src/lib.rs`) so it can be shared with mobile targets.
fn main() {
    videodubber_desktop_lib::run();
}
