' Inicia o T3 Presence sem janela. Copiado para a pasta Inicializar pelo install.
dir = "C:\Users\Ender\Documents\Dev\T3 Presence"
CreateObject("WScript.Shell").Run "node --no-warnings """ & dir & "\presence.mjs""", 0, False
