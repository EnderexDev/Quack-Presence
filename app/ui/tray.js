// O painel da bandeja: o estado, o card que está no Discord, a troca de modo e o que o menu do
// tray.ps1 tinha (configurações, reconectar, abrir config.json e log, sair).
import { call, dotFor, h, invoke, listen, start } from "./common.js";

let view = {};

function render() {
  document.getElementById("app").textContent = view.app || "StarX Studio";
  document.getElementById("dot").className = `dot ${dotFor(view.nivel)}`;
  document.getElementById("estado").textContent = view.estado || "Carregando...";
  const ativo = document.getElementById("ativo");
  const ligado = view.config?.ativo !== false;
  ativo.className = ligado ? "tog" : "tog off";
  ativo.setAttribute("aria-checked", String(ligado));
  ativo.classList.toggle("hidden", !view.configOk);

  const card = document.getElementById("card");
  card.replaceChildren();
  if (view.linha1 || view.linha2) {
    card.append(
      h("div", { class: "presence chunk" },
        h("img", { src: "capivara.png", alt: "" }),
        h("div", { class: "lines" },
          view.tipo && h("span", { class: "kind" }, view.tipo),
          view.nivel === "ok" && h("b", {}, view.app || "StarX Studio"),
          view.linha1 && h("span", { class: "ln" }, view.linha1),
          view.linha2 && h("span", { class: "ln" }, view.linha2))));
  }
  card.classList.toggle("hidden", !card.childElementCount);

  const modes = document.getElementById("modes");
  const names = Object.keys(view.config?.modos ?? {});
  modes.replaceChildren();
  if (names.length) {
    const active = view.config.modoAtivo;
    modes.append(
      h("span", { class: "label", style: "display:block;margin:0 0 6px 2px" }, "Modo do card"),
      h("div", { class: "seg full" }, names.map((name) =>
        h("button", { class: name === active ? "on" : "", onclick: () => setMode(name) }, name))));
  }
  modes.classList.toggle("hidden", !names.length);
}

/** Liga ou desliga o card sem fechar o programa; vale até ligar de novo, mesmo depois de reiniciar */
async function setActive(on) {
  view = { ...view, config: { ...view.config, ativo: on } };
  render();
  await call("send_config", { patch: { ativo: on } });
}

async function setMode(name) {
  // Marca na hora; o presence.mjs grava o config.json e o próximo estado confirma.
  view = { ...view, config: { ...view.config, modoAtivo: name } };
  render();
  await call("send_config", { patch: { modoAtivo: name } });
}

/**
 * A janela tem a altura do painel; o Rust mantém a borda de baixo colada na barra de tarefas.
 * Medido a cada mudança de tamanho, porque as fontes chegam depois do primeiro desenho.
 */
const panel = document.getElementById("tray");
function fit() {
  invoke("tray_fit", { height: Math.ceil(panel.getBoundingClientRect().height) + 9 });
}
new ResizeObserver(fit).observe(panel);

document.getElementById("ativo").addEventListener("click", () => setActive(view.config?.ativo === false));
document.getElementById("settings").addEventListener("click", () => call("show_settings"));
document.getElementById("quit").addEventListener("click", () => call("quit"));
document.getElementById("reconnect").addEventListener("click", () => call("reconnect"));
document.getElementById("config").addEventListener("click", () => call("open_file", { which: "config" }));
document.getElementById("log").addEventListener("click", () => call("open_file", { which: "log" }));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.__TAURI__.window.getCurrentWindow().hide();
});

await start((next) => {
  // Só redesenha quando algo mudou: o painel pode estar aberto com o mouse em cima dele
  if (JSON.stringify(next) === JSON.stringify(view)) return;
  view = next;
  render();
});
await listen("tray-shown", () => {
  // O anel de foco do último clique não deve receber a próxima abertura
  document.activeElement?.blur();
  fit();
});
