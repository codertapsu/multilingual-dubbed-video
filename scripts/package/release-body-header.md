<!--
  scripts/package/release-body-header.md — prepended automatically to the body of
  every draft release created by release-upload.{sh,ps1}.

  WHY THIS FILE EXISTS: release bodies were hand-written changelogs with no
  "which file do I download". The assets list shows `VideoDubber_X.Y.Z_aarch64.app.tar.gz`
  (the auto-updater payload, NOT an installer) next to the .dmg at a similar size,
  and a Mac user who picks it gets a loose .app in ~/Downloads that is signed and
  opens fine — never installed, translocated, un-updatable. That is the worst
  outcome because it silently looks like success.

  Placeholders, substituted at upload time:
    {{VERSION}}    e.g. 0.9.0            (apps/desktop/src-tauri/tauri.conf.json)
    {{MIN_MACOS}}  e.g. 14.0             (bundle.macOS.minimumSystemVersion)
  Keep it bilingual (VI first): the primary audience is Vietnamese.
-->
## Tải về / Download

| Máy của bạn / Your machine | Tệp / File |
| --- | --- |
| **Mac** (Apple Silicon, macOS {{MIN_MACOS}}+) | `VideoDubber_{{VERSION}}_aarch64.dmg` |
| **Windows** 10/11 64-bit | `VideoDubber_{{VERSION}}_x64-setup.exe` |

**macOS:** mở tệp `.dmg` rồi **kéo VideoDubber vào thư mục Applications**, sau đó mở app từ Applications (đừng mở trực tiếp trong cửa sổ .dmg).
*Open the `.dmg`, **drag VideoDubber into your Applications folder**, then open it from Applications — not from the disk image window.*

**Windows:** chạy `.exe`. Nếu SmartScreen cảnh báo, chọn *More info* → *Run anyway*.
*Run the `.exe`. If SmartScreen warns, choose **More info → Run anyway**.*

Các tệp còn lại (`.app.tar.gz`, `.sig`, `.msi`, `latest.json`) dành cho trình tự cập nhật trong app — bạn không cần tải.
*The remaining files (`.app.tar.gz`, `.sig`, `.msi`, `latest.json`) are for the in-app updater — you do not need them.*

---
