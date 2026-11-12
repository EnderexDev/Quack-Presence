; Ganchos do NSIS que o Tauri gera (bundle.windows.nsis.installerHooks no tauri.conf.json).

; Desinstalar já apaga o valor "Quack Presence" da chave Run: o desinstalador do Tauri faz isso
; fora de uma atualização (/UPDATE). O ligado/desligado dele no StartupApproved\Run, que o
; Gerenciador de Tarefas grava e o Windows não apaga, sai aqui: sem a entrada na chave Run ele não
; serve para nada, e uma instalação nova começaria com o desligado de antes.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ClearErrors
    ReadRegStr $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
    ${If} ${Errors}
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCTNAME}"
    ${EndIf}
  ${EndIf}
!macroend
