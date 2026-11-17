; NSIS hooks for the VideoDubber Windows installer (tauri.conf.json ->
; bundle.windows.nsis.installerHooks). Keep this file pure ASCII.

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
