// A janela de configurações: o que a do tray.ps1 tinha, com a prévia do card ao vivo. Salvar manda
// um pedaço do config.json ao presence.mjs, que troca só esses valores no texto do arquivo.
// O visual é o do Quackify (base.css, settings.css): três abas, Card, Comportamento e Projetos.
import { call, dotFor, h, hideWindow, listen, start, toast } from "./common.js";

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
const PROJETO = [["mostrar", "Mostrar"], ["privado", "Privado"], ["esconder", "Esconder"]];
const PILL = { ok: ["live", "No Discord"], parado: ["", "Sem card"], erro: ["bad", "Fora"] };
const ABAS = ["Card", "Comportamento", "Projetos"];

/** Ícones de traço, como os do rodapé da bandeja (tray.html) */
const ICONES = {
  config: '<path d="M8 4H7a2 2 0 0 0-2 2v3.5A2.5 2.5 0 0 1 2.5 12 2.5 2.5 0 0 1 5 14.5V18a2 2 0 0 0 2 2h1"/><path d="M16 4h1a2 2 0 0 1 2 2v3.5a2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 0-2.5 2.5V18a2 2 0 0 1-2 2h-1"/>',
  aviso: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
};
/** h() cria no espaço do HTML, onde um <svg> não desenha: o ícone passa pelo parser */
function icon(name) {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES[name]}</svg>`;
  return t.content.firstChild;
}

let view = {};
/** O formulário em edição; recarregado do config.json a cada vez que a janela abre */
let draft = null;
/** Os projetos como estão no config.json, com o que esta janela já salvou (o view chega depois) */
let saved = {};
/** A aba aberta (índice de ABAS) */
let tab = 0;

function num(value, fallback, min, max) {
  const n = value === null || value === "" ? NaN : Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? Math.round(n) : fallback));
}

function loadDraft() {
  const cfg = view.config ?? {};
  saved = structuredClone(cfg.projetos ?? {});
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
    projetos: Object.fromEntries(projectNames().map((nome) => [nome, projectState(nome)])),
  };
}

/** Os projetos do T3 e os do config.json escondidos ou privados (um que saiu do T3 ainda volta) */
function projectNames() {
  const cfg = view.config?.projetos ?? {};
  const marked = Object.keys(cfg).filter((nome) => cfg[nome]?.ignorar === true || cfg[nome]?.privado === true);
  return [...new Set([...(Array.isArray(view.projetos) ? view.projetos : []), ...marked])];
}

/** Como o presence.mjs trata o projeto: ignorar vence privado */
function projectState(nome) {
  const p = view.config?.projetos?.[nome] ?? {};
  return p.ignorar === true ? "esconder" : p.privado === true ? "privado" : "mostrar";
}

/** Só as chaves que mudaram, para o config.json não ganhar "false" em todo projeto */
function projectPatch() {
  const patch = {};
  for (const [nome, state] of Object.entries(draft.projetos)) {
    const p = saved[nome] ?? {};
    const ignorar = state === "esconder";
    // Esconder não mexe no privado
    const privado = state === "esconder" ? p.privado === true : state === "privado";
    const change = {};
    if (ignorar !== (p.ignorar === true)) change.ignorar = ignorar;
    if (privado !== (p.privado === true)) change.privado = privado;
    if (Object.keys(change).length) patch[nome] = change;
  }
  return patch;
}

/** Um texto do modo com os {campos} marcados, riscados quando desligados em "mostrar" */
function template(text) {
  return String(text ?? "")
    .split(/(\{[a-z]+\})/g)
    .filter(Boolean)
    .map((part) => {
      const key = part.match(/^\{([a-z]+)\}$/)?.[1];
      if (!key) return part;
      return h("span", { class: draft.mostrar[key] === false ? "tpl off" : "tpl" }, key);
    });
}

function preview() {
  const modo = view.config?.modos?.[draft.modoAtivo] ?? {};
  return h("div", { class: "presence", id: "preview" },
    h("img", { src: "capivara.png", alt: "" }),
    h("div", { class: "lines" },
      // Em auto, o tipo que o card tem agora (Assistindo com um jogo aberto); sem card, Jogando
      h("span", { class: "kind" }, draft.tipo === "auto" ? view.tipo || NOME_TIPO.auto : NOME_TIPO[draft.tipo]),
      h("b", {}, view.app || "StarX Studio"),
      modo.linha1 && h("span", { class: "ln" }, template(modo.linha1)),
      modo.linha2 && h("span", { class: "ln" }, template(modo.linha2)),
      draft.mostrar.timer && h("span", { class: "ln time" }, "00:42 decorrido")));
}

function seg(options, value, onpick, extra = "") {
  return h("div", { class: `seg ${extra}` }, options.map(([v, label]) =>
    h("button", { class: v === value ? "on" : "", onclick: () => { onpick(v); render(); } }, label)));
}

function toggle(on, onflip, label) {
  return h("button", { class: on ? "tog" : "tog off", role: "switch", "aria-checked": String(on), "aria-label": label, onclick: () => { onflip(!on); render(); } });
}

/** Uma linha de grupo: o nome e a dica à esquerda, o controle à direita */
function field(label, hint, control, extra = "", tip = null) {
  return h("div", { class: `row field ${extra}` },
    h("div", { class: "grow" }, h("span", { class: "title", title: tip }, label), hint && h("span", { class: "sub" }, hint)),
    control);
}

/** Um grupo com o rótulo em cima, como o "Modo do card" da bandeja */
function group(label, ...children) {
  return h("section", { class: "group" }, label && h("span", { class: "label" }, label), ...children);
}

/** Um número preso ao intervalo; quando o valor digitado é corrigido, a linha diz para quanto */
function number(key, min, max, hint) {
  return h("input", {
    class: "num", type: "number", min, max, value: draft[key], "aria-label": key,
    onchange: (event) => {
      const typed = event.target.value;
      draft[key] = num(typed, draft[key], min, max);
      event.target.value = draft[key];
      const sub = event.target.closest(".field")?.querySelector(".sub");
      const fixed = String(draft[key]) !== typed.trim();
      if (sub) {
        sub.textContent = fixed ? `Ajustado para ${draft[key]}: vai de ${min} a ${max}` : hint ?? "";
        sub.classList.toggle("fix", fixed);
        sub.classList.toggle("hidden", !fixed && !hint);
      }
    },
  });
}

/** Linha de número: a dica fica num .sub (escondido sem dica) para o aviso de valor corrigido */
function numberField(label, hint, key, min, max) {
  return h("div", { class: "row field" },
    h("div", { class: "grow" }, h("span", { class: "title" }, label), h("span", { class: hint ? "sub" : "sub hidden" }, hint ?? "")),
    number(key, min, max, hint));
}

function pill() {
  const [cls, text] = PILL[view.nivel] ?? PILL.erro;
  return h("span", { class: `pill ${cls}`, id: "pill" }, h("span", { class: `dot ${dotFor(view.nivel)}` }), text);
}

function header() {
  return h("header", { class: "top" },
    h("div", { class: "brand" },
      h("span", { class: "logo" }),
      h("div", { class: "names" }, h("span", { class: "wordmark" }, "Quack Presence"), h("span", { class: "studio", id: "app" }, view.app || "StarX Studio"))),
    h("span", { class: "grow" }),
    "configOk" in view && view.configOk && pill());
}

function cardTab(modos) {
  return [
    group("Como aparece no Discord",
      h("div", { class: "sheet card" },
        h("div", { class: "pad" }, preview()),
        modos.length > 0 && h("div", { class: "pad pick" },
          h("span", { class: "label" }, "Modo do card"),
          seg(modos.map((m) => [m, m]), draft.modoAtivo, (v) => (draft.modoAtivo = v))),
        h("div", { class: "pad pick" },
          h("span", { class: "label" }, "Tipo de atividade"),
          seg(TIPOS.map((t) => [t, t === "auto" ? "Auto" : NOME_TIPO[t]]), draft.tipo, (v) => (draft.tipo = v), "types"),
          h("p", { class: "note" }, "Auto: Assistindo com um jogo aberto, senão Jogando")))),
    group("Mostrar no card",
      h("div", { class: "sheet toggles" }, CAMPOS.map(([key, label]) =>
        h("label", { class: "row field" }, h("span", { class: "title grow" }, label),
          toggle(draft.mostrar[key], (v) => (draft.mostrar[key] = v), label)))),
      h("p", { class: "note" }, "Desligado some em qualquer modo, até num texto que o cite.")),
  ];
}

function behaviourTab() {
  return [
    group("Ociosidade",
      h("div", { class: "sheet" },
        field("Quando ocioso", null, seg([["esconder", "Esconder"], ["mostrar", "Mostrar"]], draft.quandoOcioso, (v) => (draft.quandoOcioso = v), "fit")),
        numberField("Minutos até ficar ocioso", null, "ociosoMinutos", 1, 240),
        numberField("Minutos até \"longe do PC\"", "0 desliga", "ausenteMinutos", 0, 240))),
    group("Programa",
      h("div", { class: "sheet" },
        numberField("Atualizar a cada (segundos)", null, "intervaloSegundos", 3, 3600),
        field("Seguir a conversa da última mensagem", "Desligado, vale a tarefa em foco",
          toggle(draft.seguirUltimaMensagem, (v) => (draft.seguirUltimaMensagem = v), "Seguir a conversa da última mensagem")),
        field("Iniciar com o Windows", null, toggle(draft.iniciar, (v) => (draft.iniciar = v), "Iniciar com o Windows")))),
  ];
}

function projectsTab() {
  const nomes = Object.keys(draft.projetos);
  return [
    group(null,
      // A regra vem antes da lista: com muitos projetos, embaixo ela ficaria fora da vista
      h("p", { class: "note" }, `Privado mostra "${view.config.textoProjetoPrivado || "Projeto privado"}" no lugar do nome, sem o título da conversa. Escondido, o card ignora o projeto e mostra o último que não está escondido.`),
      nomes.length === 0
        ? h("div", { class: "sheet pad empty" }, "A lista aparece quando o programa ler o T3 Code.")
        : h("div", { class: "sheet" }, nomes.map((nome) => {
          const apelido = view.config?.projetos?.[nome]?.nome;
          // Escondido fica apagado: o card ignora o projeto
          return field(nome, apelido && apelido !== nome ? `Aparece como "${apelido}"` : null,
            seg(PROJETO, draft.projetos[nome], (v) => (draft.projetos[nome] = v), "fit small"),
            draft.projetos[nome] === "esconder" ? "project gone" : "project", nome);
        }))),
  ];
}

function render() {
  const root = document.getElementById("root");
  // Cada clique redesenha tudo: sem isso, um clique na lista de projetos volta a janela ao topo
  const scrollTop = root.querySelector(".scroll")?.scrollTop ?? 0;
  root.replaceChildren();

  // Sem estado ainda (o app acabou de abrir): nada a mostrar, nem o aviso de JSON inválido
  if (!("configOk" in view)) return;
  if (!view.configOk) {
    root.append(header(), h("div", { class: "broken" },
      h("span", { class: "badge" }, icon("aviso")),
      h("h2", {}, "config.json não abriu"),
      h("p", {}, "O arquivo tem um JSON inválido. Corrija ele e esta janela volta sozinha."),
      h("button", { class: "btn primary", onclick: () => call("open_file", { which: "config" }) }, "Abrir config.json")));
    return;
  }
  if (!draft) loadDraft();

  const modos = Object.keys(view.config.modos ?? {});
  const body = [cardTab, behaviourTab, projectsTab][tab](modos);
  root.append(
    header(),
    h("nav", { class: "tabs", role: "tablist" }, ABAS.map((name, i) =>
      h("button", {
        class: i === tab ? "on" : "", role: "tab", "aria-selected": String(i === tab), "data-tab": i,
        onclick: () => { if (tab !== i) { tab = i; render(); root.querySelector(".scroll").scrollTop = 0; } },
      }, name))),
    h("div", { class: "scroll" }, body),
    // O aviso do que só se muda no arquivo fica ao lado do botão que abre o arquivo
    h("footer", { class: "foot" },
      h("button", { class: "icon-btn", title: "Abrir o config.json", "aria-label": "Abrir o config.json", onclick: () => call("open_file", { which: "config" }) }, icon("config")),
      h("p", { class: "foot-note grow" }, "Textos dos modos, nomes de projetos e imagens ficam no config.json."),
      h("button", { class: "btn", onclick: close }, "Cancelar"),
      h("button", { class: "btn primary", onclick: save }, "Salvar")));
  const scroll = root.querySelector(".scroll");
  if (scroll) scroll.scrollTop = scrollTop;
}

async function save() {
  // Na tela de JSON inválido (ou antes do primeiro estado) não há formulário para salvar
  if (!draft || !view.configOk) return;
  // Um número digitado ainda sem change entra também
  document.activeElement?.blur();
  const { iniciar, projetos, ...patch } = draft;
  const projetosPatch = projectPatch();
  if (Object.keys(projetosPatch).length) patch.projetos = projetosPatch;
  try {
    await call("send_config", { patch });
    for (const [nome, change] of Object.entries(projetosPatch)) saved[nome] = { ...saved[nome], ...change };
    // Sempre: o estado em view pode estar um ciclo atrás de um salvar anterior; repetir não muda nada
    await call("set_startup", { enabled: iniciar });
    toast("Salvo");
  } catch {
    // o toast de erro já saiu
  }
}

function close() {
  draft = null;
  hideWindow();
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") close();
  if (event.key === "Enter" && event.target.tagName !== "BUTTON") save();
});

await start((next) => {
  const wasOk = view.configOk;
  view = next;
  // Com o formulário aberto, um estado novo só troca o selo, o nome do app e a prévia (o tipo do
  // auto): redesenhar tudo apagaria o que está sendo digitado
  const old = document.getElementById("pill");
  if (draft && wasOk && view.configOk && old) {
    old.replaceWith(pill());
    document.getElementById("app").textContent = view.app || "StarX Studio";
    document.getElementById("preview")?.replaceWith(preview());
  } else render();
});
await listen("settings-shown", () => {
  draft = null;
  // Janela aberta de novo começa na primeira aba, do topo
  tab = 0;
  document.querySelector(".scroll")?.scrollTo(0, 0);
  render();
});
