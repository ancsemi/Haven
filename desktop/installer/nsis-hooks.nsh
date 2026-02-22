; Haven Desktop — NSIS Installer Hooks
; Hooks into electron-builder's NSIS installer to optionally install
; the VB-CABLE virtual audio driver during Haven setup.

!macro customInstall
  ; Ask user if they want to install VB-CABLE
  MessageBox MB_YESNO|MB_ICONQUESTION "Would you like to install VB-CABLE (virtual audio driver)?$\n$\nThis enables per-app audio streaming in voice chat.$\nYou can also install it later from Haven's settings." IDYES InstallVBCable IDNO SkipVBCable

  InstallVBCable:
    ; Check if driver installer exists in extraResources
    IfFileExists "$INSTDIR\resources\audio-drivers\VBCABLE_Setup_x64.exe" 0 DriverNotFound
    nsExec::ExecToLog '"$INSTDIR\resources\audio-drivers\VBCABLE_Setup_x64.exe" /S'
    Goto SkipVBCable

  DriverNotFound:
    MessageBox MB_OK|MB_ICONINFORMATION "VB-CABLE installer not found in package.$\nYou can download it free from https://vb-audio.com/Cable/"

  SkipVBCable:
!macroend
