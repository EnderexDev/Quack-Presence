' Inicia o T3 Presence sem janela. Copiado para a pasta Inicializar pelo install.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = "C:\Users\Ender\t3-presence"
CreateObject("WScript.Shell").Run "node --no-warnings """ & dir & "\presence.mjs""", 0, False
