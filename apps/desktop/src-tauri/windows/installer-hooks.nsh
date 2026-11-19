; NSIS hooks for the VideoDubber Windows installer (tauri.conf.json ->
; bundle.windows.nsis.installerHooks). Keep this file pure ASCII.

!macro NSIS_HOOK_PREINSTALL
  ; Close every VideoDubber background program before any file is copied.
  ; The app stops its own backend before an update (the updater's
  ; on_before_exit), but Claude Code and Claude Desktop run this same
  ; videodubber-orchestrator.exe as their VideoDubber connection (--mcp, since
  ; 0.12.0), and Windows refuses to overwrite a running program. The 0.13.0
  ; update failed on that file with Claude Code open: the installer stopped
  ; near its end, after the window and every resource were new, so the 0.13.0
  ; window came up on the 0.12.0 backend ("Route GET:/voices not found") and
  ; Windows still listed 0.12.0.
  ;
  ; taskkill ends them directly. Not Restart Manager, which the template uses
  ; for the main window just after this: it closes a console program with a
  ; console close event, which reaches every process on that console, and the
  ; connection shares Claude Code's console, so it would have closed Claude
  ; Code too (it closed the shell in the test that found this). These names are
  ; VideoDubber's own, never ffmpeg's (/T ends the ffmpeg and engines an
  ; orchestrator started). An install the user is watching asks first, and
  ; Cancel stops it before anything is closed or copied; an update (passive)
  ; or a silent install closes them. Claude reconnects when it restarts.
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /NH /FO CSV /FI "IMAGENAME eq videodubber-orchestrator.exe"'
  Pop $0
  Pop $1
  StrCpy $2 0
  ${If} $0 = 0
    ; StrLoc: the template declares it (StrFunc functions need declaring).
    ${StrLoc} $3 $1 "videodubber-orchestrator.exe" ">"
    ${If} $3 != ""
      StrCpy $2 1
    ${EndIf}
  ${EndIf}
  ${If} $2 = 1
  ${AndIfNot} ${Silent}
  ${AndIf} $PassiveMode != 1
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "VideoDubber is still running in the background, perhaps as the VideoDubber connection of Claude Code or Claude Desktop. Click OK to close it and continue installing." IDOK vd_close_background
    Abort
  ${EndIf}
  vd_close_background:
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM videodubber-orchestrator.exe /IM vd-stt-worker.exe /IM vd-translation-worker.exe /IM vd-tts-worker.exe /IM vd-piper.exe /IM vd-uv.exe'
  Pop $0
  ; Windows lets go of an ended program's file a moment after it exits.
  Sleep 1000
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Engine packs run on the bundled CPython (resources\python). Before 0.11.1 it
  ; wrote __pycache__ folders next to its sources, so the install folder held 87
  ; directories this installer never created. The uninstall above removes only
  ; the files it installed, folder by folder, and a folder that still holds a
  ; cache cannot be removed: the whole install folder was left behind. The
  ; orchestrator now sends those caches to the app's cache folder
  ; (PYTHONPYCACHEPREFIX), and this cleans up what older versions wrote.
  ; Skipped during an update: the new version is about to be copied in.
  ${If} $UpdateMode <> 1
    RMDir /r "$INSTDIR\resources\python"
    RMDir /r "$INSTDIR\resources\engine-src"
    RMDir "$INSTDIR\resources"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
