; NSIS hooks for the VideoDubber Windows installer (tauri.conf.json ->
; bundle.windows.nsis.installerHooks). Keep this file pure ASCII.
;
; The installer is the NEW version's code even when the OLD app starts it, so
; what is fixed here protects the very next update.

; One line in <home>\VideoDubber\logs\installer.log (the app's logs folder):
; an update that did not take leaves evidence. The 0.16.1 -> 0.17.0 update
; failed twice on a user's machine with nothing written anywhere.
!macro VD_LOG TEXT
  CreateDirectory "$PROFILE\VideoDubber\logs"
  ClearErrors
  FileOpen $9 "$PROFILE\VideoDubber\logs\installer.log" a
  ${IfNot} ${Errors}
    FileSeek $9 0 END
    ${GetTime} "" "L" $R0 $R1 $R2 $R3 $R4 $R5 $R6
    FileWrite $9 "$R2-$R1-$R0 $R4:$R5:$R6 ${TEXT}$\r$\n"
    FileClose $9
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro VD_LOG "installer started (update=$UpdateMode passive=$PassiveMode) into $INSTDIR"

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
    !insertmacro VD_LOG "installer cancelled by the user (background program running)"
    Abort
  ${EndIf}
  vd_close_background:

  ; Stop them, and keep stopping them until none is left (about 30 s at most):
  ; a killed process that holds graphics-card memory takes seconds to let go
  ; of its files, and a Claude session can start its connection again
  ; meanwhile (several were running when the 0.17.0 update failed). A fixed
  ; one-second wait was not enough.
  ;
  ; "None is left" means none of THESE names: the check looks for each name it
  ; kills, never for anything matching vd-*. A wildcard check also matched the
  ; installer running the check (a test installer named vdtest-...), and would
  ; hold an update for its whole half minute over any unrelated vd- program.
  StrCpy $7 0
  vd_stop_again:
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM videodubber-orchestrator.exe /IM vd-stt-worker.exe /IM vd-translation-worker.exe /IM vd-tts-worker.exe /IM vd-piper.exe /IM vd-uv.exe'
    Pop $0
    Sleep 600
    StrCpy $8 0
    nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /NH /FO CSV /FI "IMAGENAME eq videodubber-orchestrator.exe"'
    Pop $0
    Pop $1
    !insertmacro VD_FLAG_IF_LISTED "videodubber-orchestrator.exe"
    ; One listing of vd-* (a few short lines), searched for each exact name.
    nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /NH /FO CSV /FI "IMAGENAME eq vd-*"'
    Pop $0
    Pop $1
    !insertmacro VD_FLAG_IF_LISTED "vd-stt-worker.exe"
    !insertmacro VD_FLAG_IF_LISTED "vd-translation-worker.exe"
    !insertmacro VD_FLAG_IF_LISTED "vd-tts-worker.exe"
    !insertmacro VD_FLAG_IF_LISTED "vd-piper.exe"
    !insertmacro VD_FLAG_IF_LISTED "vd-uv.exe"
    ${If} $8 = 1
    ${AndIf} $7 < 25
      IntOp $7 $7 + 1
      Goto vd_stop_again
    ${EndIf}
  ${If} $8 = 1
    !insertmacro VD_LOG "background programs still running after $7 rounds; moving busy files aside"
  ${Else}
    !insertmacro VD_LOG "background programs stopped (extra rounds: $7)"
  ${EndIf}
  ; Windows lets go of an ended program's file a moment after it exits.
  Sleep 800

  ; A program still running cannot be overwritten, but it CAN be renamed: move
  ; any busy top-level program aside, so the new one is copied in its place
  ; and the old process keeps running from the renamed file until it ends. The
  ; app deletes these leftovers at its next start (sidecar.rs).
  System::Call 'kernel32::GetTickCount()i.r6'
  !insertmacro VD_MOVE_ASIDE_IF_BUSY "videodubber-orchestrator.exe"
  !insertmacro VD_MOVE_ASIDE_IF_BUSY "vd-piper.exe"
  !insertmacro VD_MOVE_ASIDE_IF_BUSY "vd-uv.exe"
  !insertmacro VD_MOVE_ASIDE_IF_BUSY "ffmpeg.exe"
  !insertmacro VD_MOVE_ASIDE_IF_BUSY "ffprobe.exe"
!macroend

; $8 = 1 when the tasklist output in $1 lists NAME (a CSV line starts with it).
!macro VD_FLAG_IF_LISTED NAME
  ${StrLoc} $3 $1 '"${NAME}"' ">"
  ${If} $3 != ""
    StrCpy $8 1
  ${EndIf}
!macroend

; Delete a top-level program before the copy; when it is busy, rename it to
; <name>.old-<ticks> instead. No labels inside: inserted several times.
!macro VD_MOVE_ASIDE_IF_BUSY NAME
  ${If} ${FileExists} "$INSTDIR\${NAME}"
    ClearErrors
    Delete "$INSTDIR\${NAME}"
    ${If} ${Errors}
      ClearErrors
      Rename "$INSTDIR\${NAME}" "$INSTDIR\${NAME}.old-$6"
      ${If} ${Errors}
        !insertmacro VD_LOG "could not delete or move aside ${NAME}"
      ${Else}
        !insertmacro VD_LOG "moved busy ${NAME} aside"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro VD_LOG "installer finished: files copied into $INSTDIR"
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
    Delete "$INSTDIR\*.old-*"
    RMDir "$INSTDIR\resources"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
