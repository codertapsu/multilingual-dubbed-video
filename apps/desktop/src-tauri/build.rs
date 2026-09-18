// Tauri build script.
//
// Runs at compile time and is responsible for:
//   * reading `tauri.conf.json`,
//   * generating the Tauri context (embedded into the binary),
//   * wiring up the capabilities/ACL,
//   * embedding icons and other bundle resources,
//   * embedding the Windows application manifest.
//
// This was a one-liner (`tauri_build::build()`) until the manifest had to be
// customised: the default manifest tauri-build embeds declares ONLY the
// Common-Controls dependency, so `VideoDubber.exe` was stuck at MAX_PATH and at
// the machine's ANSI codepage. See windows-app-manifest.xml for why both matter
// here (deep per-segment project paths under %USERPROFILE%\VideoDubber, and
// Vietnamese text everywhere).
fn main() {
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run the VideoDubber Tauri build script");
}
