// Tauri build script.
//
// Runs at compile time and is responsible for:
//   * reading `tauri.conf.json`,
//   * generating the Tauri context (embedded into the binary),
//   * wiring up the capabilities/ACL,
//   * embedding icons and other bundle resources.
//
// This is the canonical Tauri 2 build entrypoint and should remain a one-liner.
fn main() {
    tauri_build::build();
}
