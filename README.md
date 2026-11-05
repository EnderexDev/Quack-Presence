# Quack Presence

Card do Discord (Rich Presence) para o T3 Code e o Roblox, com um ícone na bandeja do Windows.
Mostra o projeto e o que está sendo feito no T3 Code, e o jogo do Roblox aberto com o botão de
entrar no servidor.

## Instalar

Baixe o [Quack-Presence-Setup.exe](https://github.com/EnderexDev/Quack-Presence/releases/latest/download/Quack-Presence-Setup.exe)
e abra. Precisa do [Node.js](https://nodejs.org) 22.13 ou mais novo.

Depois disso ele se atualiza sozinho: procura versão nova ao abrir e a cada 6 horas, instala e
volta em poucos segundos (o card some do Discord nesse meio tempo). O painel da bandeja tem o
botão "Atualizar sozinho" para desligar isso; desligado, ele avisa da versão nova e o botão
Atualizar instala quando tu quiser.

O Windows pode avisar que o app é de um editor desconhecido (ele não tem assinatura de código):
Mais informações, depois Executar assim mesmo.

## Desenvolver

```bash
node presence.mjs                      # o programa, da pasta do checkout
cd app/src-tauri && cargo build --release   # o app da bandeja que o presence.mjs abre
node tests/review-1.mjs                # os testes (1 a 9) e cargo test em app/src-tauri
```

O checkout de dev nunca se atualiza: só a cópia instalada procura versão nova. As duas usam a
mesma trava, então só uma roda por vez.

## Publicar uma versão

```bash
cd app && npm install
npm run release -- 1.2.0 "O que mudou"
```

Põe a versão nos arquivos, gera o instalador assinado com `~/.tauri/quack-presence.key`, monta o
`Quack-Presence-Setup.exe`, faz o push na master e cria a release com o `latest.json` que as
cópias instaladas leem. A chave nunca vai para o repo; sem ela as cópias instaladas não aceitam
mais atualização.
