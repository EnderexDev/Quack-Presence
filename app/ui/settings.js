// A janela de configurações: o que a do tray.ps1 tinha, com a prévia do card ao vivo. Salvar manda
// um pedaço do config.json ao presence.mjs, que troca só esses valores no texto do arquivo.
import { call, dotFor, h, listen, start, toast } from "./common.js";

// Padrões iguais aos do presence.mjs: projeto, atividade e timer ligados; o resto desligado.
const CAMPOS = [
  ["projeto", "Projeto", true],
  ["atividade", "Atividade", true],
  ["timer", "Timer", true],
  ["thread", "Título da conversa", false],
  ["modelo", "Modelo", false],
  ["agentes", "Nº de tarefas", false],
];
const TIPOS = ["auto", "jogando", "assistindo", "ouvindo", "competindo"];
const NOME_TIPO = { auto: "Jogando", jogando: "Jogando", assistindo: "Assistindo", ouvindo: "Ouvindo", competindo: "Competindo" };
const PILL = { ok: ["live", "No Discord"], parado: ["", "Sem card"], erro: ["bad", "Fora"] };

let view = {};
/** O formulário em edição; recarregado do config.json a cada vez que a janela abre */
let draft = null;

function num(value, fallback, min, max) {
  const n = value === null || value === "" ? NaN : Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? Math.round(n) : fallback));
}

function loadDraft() {
  const cfg = view.config ?? {};
  const mostrar = {};
  for (const [key, , padrao] of CAMPOS) mostrar[key] = cfg.mostrar?.[key] ?? padrao;
  draft = {
    modoAtivo: cfg.modos?.[cfg.modoAtivo] ? cfg.modoAtivo : (Object.keys(cfg.modos ?? {})[0] ?? ""),
    mostrar,
    tipo: TIPOS.includes(cfg.tipo) ? cfg.tipo : "auto",
    quandoOcioso: cfg.quandoOcioso === "mostrar" ? "mostrar" : "esconder",
    ociosoMinutos: num(cfg.ociosoMinutos, 15, 1, 240),
    ausenteMinutos: num(cfg.ausenteMinutos, 5, 0, 240),
    intervaloSegundos: num(cfg.intervaloSegundos, 5, 3, 3600),
    seguirUltimaMensagem: cfg.seguirUltimaMensagem !== false,
    iniciar: Boolean(view.iniciarComWindows),
  };
}

/** Um texto do modo com os {campos} em amarelo, riscados quando desligados em "mostrar" */
function template(text) {
  return String(text ?? "")
    .split(/(\{[a-z]+\})/g)
    .filter(Boolean)
    .map((part) => {
      const key = part.match(/^\{([a-z]+)\}$/)?.[1];
      if (!key) return part;
      return h("span", { class: draft.mostrar[key] === false ? "tpl off" : "tpl" }, part);
    });
}

function preview() {
  const modo = view.config?.modos?.[draft.modoAtivo] ?? {};
  return h("div", { class: "presence chunk", id: "preview" },
    h("img", { src: "capivara.png", alt: "" }),
    h("div", { class: "lines" },
      // Em auto, o tipo que o card tem agora (Assistindo com um jogo aberto); sem card, Jogando
      h("span", { class: "kind" }, draft.tipo === "auto" ? view.tipo || NOME_TIPO.auto : NOME_TIPO[draft.tipo]),
      h("b", {}, view.app || "StarX Studio"),
      modo.linha1 && h("span", { class: "ln" }, template(modo.linha1)),
      modo.linha2 && h("span", { class: "ln" }, template(modo.linha2)),
      draft.mostrar.timer && h("span", { class: "ln time" }, "00:42 decorrido")));
}

function seg(options, value, onpick, full = true) {
  return h("div", { class: full ? "seg full" : "seg" }, options.map(([v, label]) =>
    h("button", { class: v === value ? "on" : "", onclick: () => { onpick(v); render(); } }, label)));
}

function toggle(on, onflip) {
  return h("button", { class: on ? "tog" : "tog off", role: "switch", "aria-checked": String(on), onclick: () => { onflip(!on); render(); } });
}

function field(label, hint, control) {
  return h("div", { class: "field" }, h("div", { class: "grow" }, label, hint && h("span", { class: "hint" }, hint)), control);
}

function number(key, min, max) {
  return h("input", {
    class: "field-input", type: "number", min, max, value: draft[key],
    onchange: (event) => {
      draft[key] = num(event.target.value, draft[key], min, max);
      event.target.value = draft[key];
    },
  });
}

function pill() {
  const [cls, text] = PILL[view.nivel] ?? PILL.erro;
  return h("span", { class: `pill ${cls}`, id: "pill" }, h("span", { class: `dot ${dotFor(view.nivel)}` }), text);
}

function render() {
  const root = document.getElementById("root");
  root.replaceChildren();

  // Sem estado ainda (o app acabou de abrir): nada a mostrar, nem o aviso de JSON inválido
  if (!("configOk" in view)) return;
  if (!view.configOk) {
    root.append(h("div", { class: "offline" },
      h("h2", { class: "display" }, "config.json não abriu"),
      h("p", { class: "muted", style: "margin:0;line-height:1.6" }, "O arquivo tem um JSON inválido. Corrija ele e esta janela volta sozinha."),
      h("button", { class: "btn yellow chunk-bright press", onclick: () => call("open_file", { which: "config" }) }, "Abrir config.json")));
    return;
  }
  if (!draft) loadDraft();

  const modos = Object.keys(view.config.modos ?? {});
  root.append(h("div", { class: "scroll" },
    h("div", { class: "head" },
      h("div", { class: "grow" },
        h("span", { class: "brandtag" }, "Quack Presence"),
        h("h1", { class: "display", style: "margin-top:12px" }, "Configurações"),
        h("div", { class: "bar" })),
      pill()),

    h("div", { class: "card" },
      h("span", { class: "label" }, "Como aparece no Discord"),
      preview(),
      modos.length > 0 && h("div", { style: "margin-top:12px" },
        h("span", { class: "label", style: "display:block;margin-bottom:6px" }, "Modo do card"),
        seg(modos.map((m) => [m, m]), draft.modoAtivo, (v) => (draft.modoAtivo = v)))),

    h("div", { class: "card" },
      h("span", { class: "label" }, "Mostrar no card"),
      h("div", { class: "toggles" }, CAMPOS.map(([key, label]) =>
        field(label, null, toggle(draft.mostrar[key], (v) => (draft.mostrar[key] = v))))),
      h("p", { class: "note" }, "Desligado some em qualquer modo, até num texto que o cite.")),

    h("div", { class: "card" },
      h("span", { class: "label" }, "Comportamento"),
      field("Tipo de atividade", "Auto: Assistindo com um jogo aberto, senão Jogando",
        h("select", { class: "field-input", onchange: (e) => { draft.tipo = e.target.value; render(); } },
          TIPOS.map((t) => h("option", { value: t, selected: t === draft.tipo }, t)))),
      field("Quando ocioso", null, seg([["esconder", "Esconder"], ["mostrar", "Mostrar"]], draft.quandoOcioso, (v) => (draft.quandoOcioso = v), false)),
      field("Minutos até ficar ocioso", null, number("ociosoMinutos", 1, 240)),
      field("Minutos até \"longe do PC\"", "0 desliga", number("ausenteMinutos", 0, 240)),
      field("Atualizar a cada (segundos)", null, number("intervaloSegundos", 3, 3600)),
      field("Seguir a conversa da última mensagem", "Desligado, vale a tarefa em foco",
        toggle(draft.seguirUltimaMensagem, (v) => (draft.seguirUltimaMensagem = v))),
      field("Iniciar com o Windows", null, toggle(draft.iniciar, (v) => (draft.iniciar = v)))),

    h("p", { class: "note", style: "margin:0;text-align:center" }, "Textos dos modos, nomes de projetos e imagens ficam no config.json.")));

  root.append(h("div", { class: "foot" },
    h("button", { class: "btn dark chunk press", onclick: () => call("open_file", { which: "config" }) }, "Abrir config.json"),
    h("span", { class: "grow" }),
    h("button", { class: "btn dark chunk press", onclick: close }, "Cancelar"),
    h("button", { class: "btn yellow chunk-bright press", onclick: save }, "Salvar")));
}

async function save() {
  // Na tela de JSON inválido (ou antes do primeiro estado) não há formulário para salvar
  if (!draft || !view.configOk) return;
  // Um número digitado ainda sem change entra também
  document.activeElement?.blur();
  const { iniciar, ...patch } = draft;
  try {
    await call("send_config", { patch });
    // Sempre: o estado em view pode estar um ciclo atrás de um salvar anterior; repetir não muda nada
    await call("set_startup", { enabled: iniciar });
    toast("Salvo");
  } catch {
    // o toast de erro já saiu
  }
}

function close() {
  draft = null;
  window.__TAURI__.window.getCurrentWindow().hide();
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") close();
  if (event.key === "Enter" && event.target.tagName !== "BUTTON") save();
});

await start((next) => {
  const wasOk = view.configOk;
  view = next;
  // Com o formulário aberto, um estado novo só troca o selo e a prévia (o tipo do auto, o nome do
  // app): redesenhar tudo apagaria o que está sendo digitado
  const old = document.getElementById("pill");
  if (draft && wasOk && view.configOk && old) {
    old.replaceWith(pill());
    document.getElementById("preview")?.replaceWith(preview());
  } else render();
});
await listen("settings-shown", () => {
  draft = null;
  render();
});
