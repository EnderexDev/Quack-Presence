' Inicia o Quack Presence sem janela. Copiado para a pasta Inicializar pelo install.
dir = "E:\Documents\Dev\Quack Presence"
CreateObject("WScript.Shell").Run "node --no-warnings """ & dir & "\presence.mjs""", 0, False
