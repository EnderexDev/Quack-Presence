// Quack Presence: Discord Rich Presence para o T3 Code e o Roblox.
// Lê o estado do T3 (statev2.sqlite, só leitura) e publica no Discord pelo IPC local. Com o Roblox
// aberto, publica também um card "Jogando" do jogo, lido do log do Roblox Player, num app à parte.
// Uso: node presence.mjs            (roda para sempre)
//      node presence.mjs --once     (publica uma vez, imprime o que mandou e sai)
//      node presence.mjs --dry      (só imprime a atividade calculada, sem Discord)
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import readline from "node:readline";
import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(DIR, "config.json");
const DEFAULT_CONFIG_PATH = path.join(DIR, "config.default.json");
const LOG_PATH = path.join(DIR, "presence.log");
const STATUS_PATH = path.join(DIR, "presence.status.json");
const T3_HOME = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
const DB_PATH = path.join(T3_HOME, "userdata", "statev2.sqlite");
const RUNTIME_PATH = path.join(T3_HOME, "userdata", "server-runtime.json");
const ARGS = new Set(process.argv.slice(2));

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}\n`;
  if (ARGS.has("--once") || ARGS.has("--dry")) process.stdout.write(line);
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 1_000_000) fs.writeFileSync(LOG_PATH, "");
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

// ---------- config ----------

let config = null;
let configMtime = 0;
function loadConfig() {
  try {
    const mtime = fs.statSync(CONFIG_PATH).mtimeMs;
    if (config && mtime === configMtime) return config;
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    configMtime = mtime;
    log("config carregado, modo:", config.modoAtivo);
  } catch (e) {
    log("config inválido, mantendo o anterior:", e.message);
    if (!config) throw e;
  }
  return config;
}

// Leitura de posições no texto do JSON, para o patchText trocar um valor sem mexer no resto.
const skipWs = (t, i) => {
  while (i < t.length && /\s/.test(t[i])) i++;
  return i;
};
function scanString(t, i) {
  for (i++; i < t.length && t[i] !== '"'; i++) if (t[i] === "\\") i++;
  return i + 1;
}
function scanValue(t, i) {
  if (t[i] === '"') return scanString(t, i);
  if (t[i] !== "{" && t[i] !== "[") return i + (/^[^,}\]\s]*/.exec(t.slice(i))?.[0].length ?? 0);
  let depth = 0;
  for (; i < t.length; i++) {
    if (t[i] === '"') i = scanString(t, i) - 1;
    else if (t[i] === "{" || t[i] === "[") depth++;
    else if ((t[i] === "}" || t[i] === "]") && --depth === 0) return i + 1;
  }
  return t.length;
}
/** Os membros do objeto que abre em t[open]: chave -> [início da chave, início do valor, fim do valor] */
function members(t, open) {
  const out = new Map();
  let i = skipWs(t, open + 1);
  while (i < t.length && t[i] === '"') {
    const keyEnd = scanString(t, i);
    const valueStart = skipWs(t, skipWs(t, keyEnd) + 1);
    const valueEnd = scanValue(t, valueStart);
    out.set(JSON.parse(t.slice(i, keyEnd)), [i, valueStart, valueEnd]);
    i = skipWs(t, valueEnd);
    if (t[i] === ",") i = skipWs(t, i + 1);
  }
  return { members: out, close: i };
}
/** Um objeto numa linha só, como os do config: { "nome": "X", "ignorar": true } */
function inline(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const parts = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`);
  return parts.length ? `{ ${parts.join(", ")} }` : "{}";
}

// Aplica um pedaço do config ao texto do arquivo, trocando só os valores (e inserindo a chave que
// faltar no objeto dela) para manter o arquivo como foi escrito à mão. Se o resultado não bater
// com o esperado, devolve o JSON inteiro regravado.
function patchText(text, patch) {
  const want = JSON.parse(text);
  const leaves = [];
  const walk = (obj, into, keys) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (!into[k] || typeof into[k] !== "object" || Array.isArray(into[k])) into[k] = {};
        walk(v, into[k], [...keys, k]);
      } else {
        into[k] = v;
        leaves.push([[...keys, k], v]);
      }
    }
  };
  walk(patch, want, []);

  let out = text;
  for (const [keys, value] of leaves) {
    let open = skipWs(out, 0);
    if (out[open] !== "{") break;
    for (let depth = 0; depth < keys.length; depth++) {
      const { members: found, close } = members(out, open);
      const hit = found.get(keys[depth]);
      const last = depth === keys.length - 1;
      if (hit && (last || out[hit[1]] !== "{")) {
        // A chave existe: troca o valor (um objeto no meio do caminho que não é objeto vai inteiro)
        const sub = last ? value : keys.slice(depth + 1).reduceRight((v, k) => ({ [k]: v }), value);
        out = out.slice(0, hit[1]) + (last ? JSON.stringify(sub) : inline(sub)) + out.slice(hit[2]);
        break;
      }
      if (hit) {
        open = hit[1];
        continue;
      }
      // A chave falta: entra no fim do objeto, na linha própria se os irmãos estão em linhas próprias
      const sub = keys.slice(depth + 1).reduceRight((v, k) => ({ [k]: v }), value);
      const member = `${JSON.stringify(keys[depth])}: ${inline(sub)}`;
      const prev = [...found.values()].at(-1);
      if (!prev) {
        out = out.slice(0, open) + `{ ${member} }` + out.slice(close + 1);
        break;
      }
      const lineStart = out.lastIndexOf("\n", prev[0]) + 1;
      const indent = out.slice(lineStart, prev[0]);
      const sep = /^[ \t]*$/.test(indent) ? `,\n${indent}` : ", ";
      out = out.slice(0, prev[2]) + sep + member + out.slice(prev[2]);
      break;
    }
  }
  let same = false;
  try {
    same = isDeepStrictEqual(JSON.parse(out), want);
  } catch {}
  return same ? out : JSON.stringify(want, null, 2) + "\n";
}

// Muda campos do config pela janela da bandeja.
function patchConfig(patch) {
  const text = fs.readFileSync(CONFIG_PATH, "utf8");
  const out = patchText(text, patch);
  if (out === text) return;
  fs.writeFileSync(CONFIG_PATH + ".tmp", out);
  fs.renameSync(CONFIG_PATH + ".tmp", CONFIG_PATH);
  log("config salvo pela bandeja:", JSON.stringify(patch));
}

// ---------- estado do T3 ----------

function t3Running() {
  try {
    const { pid } = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Nomes dos .exe abertos, em minúsculas. tasklist custa ~100 ms, então a lista vale por 30 s.
let exeCache = { at: 0, names: new Set() };
function runningExes() {
  if (Date.now() - exeCache.at < 30_000) return exeCache.names;
  let names = new Set();
  try {
    // chcp 65001: sem ele o tasklist sai na página OEM (850) e um .exe com acento não bate.
    const out = execFileSync("cmd", ["/d", "/c", "chcp 65001 >nul & tasklist /fo csv /nh"], {
      encoding: "utf8",
      windowsHide: true,
    });
    // Primeiro campo entre aspas inteiro: um nome de .exe pode ter vírgula.
    names = new Set(out.split("\n").map((l) => l.match(/^"([^"]*)"/)?.[1].toLowerCase()).filter(Boolean));
  } catch {}
  exeCache = { at: Date.now(), names };
  return names;
}

// Jogo aberto: o Discord mostra um "Jogando" por vez, e o do jogo esconde o nosso.
function gameRunning(cfg) {
  const games = (cfg.jogos || []).map((g) => g.toLowerCase());
  if (!games.length) return false;
  const names = runningExes();
  return games.some((g) => names.has(g));
}

// ---------- estado do Roblox ----------

// O Roblox Player escreve no log cada entrada num servidor: "! Joining game '<jobId>' place <placeId>",
// logo seguida de "game_join_loadtime: ... universeid:<id>, referral_page:<origem>". Um teleporte
// escreve as duas de novo. Voltar para o app (fora de jogo) escreve "setStage: (stage:Native)".
// T3P_ROBLOX_LOGS e T3P_ROBLOX_RUNNING (1/0) trocam a pasta e o processo nos testes.
const ROBLOX_LOGS = process.env.T3P_ROBLOX_LOGS || path.join(process.env.LOCALAPPDATA || "", "Roblox", "logs");
const ROBLOX_EXE = "robloxplayerbeta.exe";
let rbx = { file: "", offset: 0, rest: "", join: null, session: null };

function robloxRunning() {
  const env = process.env.T3P_ROBLOX_RUNNING;
  if (env !== undefined) return env === "1";
  return runningExes().has(ROBLOX_EXE);
}

function readRobloxSession() {
  if (!robloxRunning()) {
    rbx.session = null;
    return null;
  }
  // O log mais novo do Player (o do Studio e o do CrashHandler ficam de fora). O Roblox abre um log
  // curto de inicialização junto, mas o da sessão é o que segue sendo escrito.
  let newest = null;
  try {
    for (const name of fs.readdirSync(ROBLOX_LOGS)) {
      if (!/_Player_[0-9A-F]+_last\.log$/i.test(name)) continue;
      const mtime = fs.statSync(path.join(ROBLOX_LOGS, name)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { name, mtime };
    }
  } catch {}
  if (!newest) return null;
  if (newest.name !== rbx.file) rbx = { file: newest.name, offset: 0, rest: "", join: null, session: null };

  // Só o que entrou desde a última leitura: o log de uma tarde passa de 10 MB.
  const full = path.join(ROBLOX_LOGS, rbx.file);
  const fd = fs.openSync(full, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size < rbx.offset) rbx = { ...rbx, offset: 0, rest: "", join: null, session: null };
    if (size > rbx.offset) {
      const buf = Buffer.alloc(size - rbx.offset);
      fs.readSync(fd, buf, 0, buf.length, rbx.offset);
      rbx.offset = size;
      const lines = (rbx.rest + buf.toString("utf8")).split("\n");
      rbx.rest = lines.pop();
      for (const line of lines) parseRobloxLine(line);
    }
  } finally {
    fs.closeSync(fd);
  }
  return rbx.session;
}

function parseRobloxLine(line) {
  let m;
  if ((m = line.match(/! Joining game '([0-9a-f-]+)' place (\d+)/))) {
    rbx.join = { jobId: m[1], placeId: m[2], at: Date.parse(line.slice(0, 24)) || Date.now() };
  } else if ((m = line.match(/game_join_loadtime: placeid:(\d+),.*?universeid:(\d+), referral_page:([^,]*)/))) {
    const prev = rbx.session;
    const universeId = m[2];
    // Teleporte dentro do mesmo jogo chega com referral_page vazio: o tempo de jogo e o servidor
    // privado continuam os da entrada.
    const same = prev?.universeId === universeId && m[3] === "";
    rbx.session = {
      jobId: rbx.join?.jobId || "",
      placeId: m[1],
      universeId,
      privado: m[3] === "RequestPrivateGame" || (same && prev.privado),
      desde: same ? prev.desde : rbx.join?.at || Date.now(),
    };
  } else if (line.includes("setStage: (stage:Native)") || line.includes("leaveUGCGame")) {
    rbx.join = null;
    rbx.session = null;
  }
}

// Nome, jogadores e ícone pela API pública, guardados por jogo. Cada valor novo de jogadores é um
// SET_ACTIVITY, então ele só é relido a cada atualizarSegundos. T3P_ROBLOX_API troca as duas URLs
// por um servidor de teste (<base>/games e <base>/icons).
const ROBLOX_API = process.env.T3P_ROBLOX_API;
const gameInfo = new Map();

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.json();
}

async function robloxGame(cfg, universeId) {
  const cached = gameInfo.get(universeId);
  const ttl = Math.max(30, Number(cfg.roblox?.atualizarSegundos) || 60) * 1000;
  if (cached && Date.now() - cached.at < ttl) return cached;
  const id = encodeURIComponent(universeId);
  const gamesUrl = ROBLOX_API ? `${ROBLOX_API}/games?universeIds=${id}` : `https://games.roblox.com/v1/games?universeIds=${id}`;
  const iconUrl = ROBLOX_API
    ? `${ROBLOX_API}/icons?universeIds=${id}`
    : `https://thumbnails.roblox.com/v1/games/icons?universeIds=${id}&size=512x512&format=Png`;
  try {
    const g = (await fetchJson(gamesUrl)).data?.[0];
    if (!g) throw new Error("jogo não encontrado");
    let icone = cached?.icone || "";
    if (!icone) {
      try {
        const t = (await fetchJson(iconUrl)).data?.[0];
        if (t?.state === "Completed") icone = t.imageUrl || "";
      } catch (e) {
        log("ícone do jogo não veio:", e.message);
      }
    }
    const info = { at: Date.now(), nome: g.name || "", jogando: g.playing ?? null, criador: g.creator?.name || "", icone };
    gameInfo.set(universeId, info);
    return info;
  } catch (e) {
    log("API do Roblox falhou:", e.message);
    // Guarda a falha pelo mesmo tempo: sem isso a API é chamada a cada ciclo enquanto estiver fora.
    const info = { ...(cached || { nome: "", jogando: null, criador: "", icone: "" }), at: Date.now() };
    gameInfo.set(universeId, info);
    return info;
  }
}

let stickyRunId = null;
let stickyBlockStart = null;
let stickyLastEnd = 0;
let db = null;
function openDb() {
  if (!db) db = new DatabaseSync(DB_PATH, { readOnly: true });
  return db;
}

const RUN_COLS = `r.run_id, r.thread_id, r.status, r.requested_at, r.completed_at, r.payload_json,
  t.title AS thread_title, p.title AS project_title`;
const RUN_JOIN = `FROM orchestration_v2_projection_runs r
  JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
  LEFT JOIN projection_projects p ON p.project_id = t.project_id`;

function readState(cfg) {
  const d = openDb();
  const running = d.prepare(`SELECT ${RUN_COLS} ${RUN_JOIN} WHERE r.status = 'running'`).all();
  const recent = d
    .prepare(
      `SELECT ${RUN_COLS} ${RUN_JOIN} WHERE r.requested_at >= ?1 OR r.completed_at >= ?1 ORDER BY r.requested_at DESC`,
    )
    .all(new Date(Date.now() - 24 * 3600_000).toISOString());

  const ignored = (run) => cfg.projetos?.[run.project_title]?.ignorar === true;
  const activeRuns = running.filter((r) => !ignored(r));
  const recentRuns = recent.filter((r) => !ignored(r));

  // Run em foco: a mesma enquanto ela rodar (senão o card alterna entre threads paralelas);
  // quando ela acaba, a que mexeu por último.
  const itemStmt = d.prepare(`SELECT type, status, updated_at FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ? AND run_id = ? ORDER BY ordinal DESC LIMIT 8`);
  const latestItem = (run) => {
    const items = itemStmt.all(run.thread_id, run.run_id);
    return items.find((i) => i.status === "running") || items[0] || null;
  };
  let focus = activeRuns.find((r) => r.run_id === stickyRunId) || null;
  let focusItem = focus ? latestItem(focus) : null;
  if (!focus) {
    for (const run of activeRuns) {
      const item = latestItem(run);
      const touched = item?.updated_at || run.requested_at;
      if (!focus || touched > (focusItem?.updated_at || focus.requested_at)) {
        focus = run;
        focusItem = item;
      }
    }
  }
  stickyRunId = focus?.run_id ?? null;

  // Sessão aberta: o T3 não diz qual conversa está na tela, então vale a da última mensagem
  // do usuário. Ela manda no projeto; a atividade vem dela se estiver rodando.
  let openRun = null;
  if (cfg.seguirUltimaMensagem !== false) {
    const known = [...activeRuns, ...recentRuns];
    const msgs = d
      .prepare(`SELECT thread_id FROM orchestration_v2_projection_turn_items
        WHERE type = 'user_message' ORDER BY updated_at DESC LIMIT 30`)
      .all();
    for (const { thread_id } of msgs) {
      const runs = known.filter((r) => r.thread_id === thread_id);
      if (!runs.length) continue;
      openRun = runs.reduce((a, b) => (b.requested_at > a.requested_at ? b : a));
      break;
    }
    if (openRun) {
      focus = openRun.status === "running" ? openRun : null;
      focusItem = focus ? latestItem(focus) : null;
    }
  }

  // Bloco de trabalho: runs encadeadas sem pausa maior que ociosoMinutos.
  const gapMs = (cfg.ociosoMinutos ?? 15) * 60_000;
  // Intervalos ordenados pelo fim: uma run antiga ainda rodando entra antes das que já acabaram.
  const now = Date.now();
  // activeRuns entra junto: uma run rodando há mais de 24h fica fora de recentRuns.
  const seen = new Set();
  const spans = [...activeRuns, ...recentRuns]
    .filter((r) => !seen.has(r.run_id) && seen.add(r.run_id))
    .map((r) => ({
      run: r,
      start: Date.parse(r.requested_at),
      end: r.status === "running" ? now : Date.parse(r.completed_at || r.requested_at),
    }))
    .sort((a, b) => b.end - a.end);
  const lastEnd = spans[0]?.end ?? 0;
  let blockStart = null;
  let edge = now;
  for (const s of spans) {
    if (edge - s.end > gapMs) break;
    blockStart = Math.min(blockStart ?? s.start, s.start);
    edge = Math.min(edge, s.start);
  }

  const idle = activeRuns.length === 0 && Date.now() - lastEnd > gapMs;
  // A consulta só vê 24h: um bloco mais longo que isso guarda o início já visto até ficar ocioso.
  // Um bloco novo que começa mais de gapMs depois do último fim visto é outro bloco, mesmo que
  // nenhum ciclo tenha visto o ocioso no meio (PC dormindo, programa pausado).
  if (stickyBlockStart !== null && blockStart !== null && blockStart - stickyLastEnd > gapMs) stickyBlockStart = null;
  if (idle) stickyBlockStart = null;
  else if (blockStart !== null) stickyBlockStart = Math.min(stickyBlockStart ?? blockStart, blockStart);
  stickyLastEnd = lastEnd;
  if (!idle && stickyBlockStart !== null) blockStart = stickyBlockStart;
  // Entre tarefas, o projeto é o da run que terminou por último, não o da última pedida.
  const last = openRun || focus || spans[0]?.run || null;
  return { idle, focus, focusItem, last, agents: activeRuns.length, blockStart };
}

// Os projetos do T3, do usado por último ao mais antigo, para a janela de configurações listar.
// Custa uns 20 ms: relê a cada minuto. Uma falha mantém a lista anterior e não afeta o card.
let projectsAt = 0;
function listProjects() {
  if (Date.now() - projectsAt < 60_000) return;
  projectsAt = Date.now();
  try {
    status.projetos = openDb()
      .prepare(
        `SELECT p.title FROM projection_projects p
        LEFT JOIN orchestration_v2_projection_threads t ON t.project_id = p.project_id
        LEFT JOIN orchestration_v2_projection_runs r ON r.thread_id = t.thread_id
        WHERE p.deleted_at IS NULL GROUP BY p.project_id ORDER BY MAX(r.requested_at) DESC, p.title`,
      )
      .all()
      .map((p) => p.title);
  } catch (e) {
    log("falha listando os projetos do T3:", e.message);
  }
}

// Longe do PC: a bandeja manda "input <ms>" (tempo desde o último teclado ou mouse) a cada 2 s.
// Sem notícia dela há 30 s (bandeja fechou, --dry), não dá para saber: conta como presente.
// T3P_IDLE_MS fixa o valor nos testes, que rodam sem bandeja.
let inputIdleMs = null;
let inputSeenAt = 0;
let wasAway = false;
function awayMs(cfg) {
  const env = process.env.T3P_IDLE_MS;
  let ms = null;
  if (env !== undefined) ms = Number(env);
  else if (Date.now() - inputSeenAt < 30_000) ms = inputIdleMs + (Date.now() - inputSeenAt);
  const limit = (cfg.ausenteMinutos ?? 5) * 60_000;
  return ms !== null && Number.isFinite(ms) && limit > 0 && ms >= limit ? ms : null;
}

// ---------- montagem da atividade ----------

const TYPES = { jogando: 0, ouvindo: 2, assistindo: 3, competindo: 5 };
const DISPLAY = { nome: 0, linha2: 1, linha1: 2 };
const MAX_FRAME = 1_000_000;

function prettyModel(cfg, model) {
  if (!model) return "";
  if (cfg.nomesModelo?.[model]) return cfg.nomesModelo[model];
  return model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/^\w/, (c) => c.toUpperCase());
}

function fill(template, values) {
  if (!template) return "";
  const out = template.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? "");
  // Placeholder vazio não deixa separador sobrando: "A ·  · B" vira "A · B".
  return out
    .split(/\s*·\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" · ")
    .trim();
}

function clamp(s, max = 128) {
  if (!s) return undefined;
  if (s.length < 2) s = s + " ";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Em minutos, nunca segundos: cada texto novo é um SET_ACTIVITY.
function formatAway(ms) {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h` + (min % 60 ? ` ${min % 60} min` : "");
}

function buildActivity(cfg, state) {
  if (state.idle && cfg.quandoOcioso !== "mostrar") return null;
  const show = cfg.mostrar || {};
  const run = state.last;
  const projCfg = cfg.projetos?.[run?.project_title] || {};
  const privado = projCfg.privado === true;

  let atividade = "";
  if (state.awayMs !== null) atividade = (cfg.textoAusente || "").replace("{tempo}", formatAway(state.awayMs));
  else if (state.idle) atividade = cfg.textoOcioso || "";
  else if (state.focusItem && state.focus) atividade = cfg.atividades?.[state.focusItem.type] || cfg.atividades?.dynamic_tool || "";
  else atividade = cfg.atividades?.entreTarefas || "";

  let model = "";
  try {
    model = JSON.parse(run?.payload_json || "{}").modelSelection?.model || "";
  } catch {}

  const values = {
    projeto: show.projeto === false ? "" : privado ? cfg.textoProjetoPrivado || "" : projCfg.nome || run?.project_title || "",
    thread: show.thread !== true || privado ? "" : run?.thread_title || "",
    atividade: show.atividade === false ? "" : atividade,
    modelo: show.modelo !== true ? "" : prettyModel(cfg, model),
    agentes: show.agentes !== true || state.agents < 2 ? "" : `${state.agents} tarefas`,
  };

  const mode = cfg.modos?.[cfg.modoAtivo] || cfg.modos?.discreto || { linha1: "Programando" };
  const activity = {
    type:
      cfg.tipo === "auto"
        ? TYPES[gameRunning(cfg) ? cfg.tipoComJogo : cfg.tipoSemJogo] ?? 0
        : TYPES[cfg.tipo] ?? 0,
    details: clamp(fill(mode.linha1, values)),
    state: clamp(fill(mode.linha2, values)),
    instance: false,
  };
  if (cfg.textoNaListaDeMembros in DISPLAY) activity.status_display_type = DISPLAY[cfg.textoNaListaDeMembros];

  if (show.timer !== false && state.blockStart && !state.idle) activity.timestamps = { start: state.blockStart };

  // A imagem do projeto entrega o projeto: no privado, fica a padrão.
  const img = { ...(cfg.imagem || {}), ...(projCfg.imagem && !privado ? { grande: projCfg.imagem } : {}) };
  const assets = {};
  if (img.grande) assets.large_image = img.grande;
  if (img.grande && img.textoGrande) assets.large_text = clamp(fill(img.textoGrande, values));
  if (img.pequena) assets.small_image = img.pequena;
  if (img.pequena && img.textoPequena) assets.small_text = clamp(fill(img.textoPequena, values));
  if (Object.keys(assets).length) activity.assets = assets;

  const buttons = (cfg.botoes || []).filter((b) => b?.label && b?.url).slice(0, 2);
  if (buttons.length) activity.buttons = buttons.map((b) => ({ label: b.label.slice(0, 32), url: b.url }));

  for (const k of Object.keys(activity)) if (activity[k] === undefined) delete activity[k];
  return activity;
}

// Card "Jogando" do Roblox, num app do Discord só dele (o título do card é o nome do app).
// Uma linha que pede um valor que não veio (a API fora do ar) sai do card em vez de ficar pela metade.
function buildRobloxActivity(cfg, session, info) {
  const r = cfg.roblox || {};
  const values = {
    jogo: info?.nome || "Roblox",
    jogando: info?.jogando != null ? Number(info.jogando).toLocaleString("pt-BR") : "",
    criador: info?.criador || "",
  };
  const line = (template) => {
    if (!template) return undefined;
    const keys = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    return keys.some((k) => !values[k]) ? undefined : clamp(fill(template, values));
  };
  const activity = {
    type: TYPES.jogando,
    details: line(r.linha1 ?? "{jogo}"),
    state: line(r.linha2),
    timestamps: r.timer === false ? undefined : { start: session.desde },
    instance: false,
  };
  if ((r.textoNaListaDeMembros ?? "linha1") in DISPLAY) activity.status_display_type = DISPLAY[r.textoNaListaDeMembros ?? "linha1"];

  const image = info?.icone || r.imagem;
  if (image) activity.assets = { large_image: image, large_text: line(r.textoImagem) };

  // Servidor privado não aceita quem chega pelo jobId: lá só vai o botão da página do jogo.
  const buttons = [];
  if (r.botaoEntrar && session.jobId && !session.privado)
    buttons.push({
      label: r.botaoEntrar,
      url: `https://www.roblox.com/games/start?placeId=${session.placeId}&gameInstanceId=${session.jobId}`,
    });
  if (r.botaoJogo) buttons.push({ label: r.botaoJogo, url: `https://www.roblox.com/games/${session.placeId}` });
  if (buttons.length) activity.buttons = buttons.map((b) => ({ label: b.label.slice(0, 32), url: b.url }));

  for (const obj of [activity, activity.assets || {}])
    for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return activity;
}

// ---------- IPC do Discord ----------

class DiscordIpc {
  constructor(clientId) {
    this.clientId = clientId;
    this.sock = null;
    this.ready = false;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.nonce = 0;
  }

  async connect() {
    // T3P_IPC_PIPE aponta para um pipe de teste no lugar do Discord.
    const pipes = process.env.T3P_IPC_PIPE
      ? [process.env.T3P_IPC_PIPE]
      : Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
    for (const pipe of pipes) {
      try {
        await this.tryPipe(pipe);
        return true;
      } catch {}
    }
    return false;
  }

  tryPipe(pipePath) {
    return new Promise((resolve, reject) => {
      this.buf = Buffer.alloc(0);
      const sock = net.createConnection(pipePath);
      const fail = (e) => {
        sock.destroy();
        reject(e);
      };
      sock.once("error", fail);
      sock.once("connect", () => {
        this.sock = sock;
        sock.on("data", (d) => this.onData(d));
        sock.on("close", () => this.onClose());
        sock.removeListener("error", fail);
        sock.on("error", () => {});
        this.readyResolve = () => {
          this.ready = true;
          resolve();
        };
        this.send(0, { v: 1, client_id: this.clientId });
        setTimeout(() => !this.ready && fail(new Error("sem READY")), 5000).unref();
      });
    });
  }

  send(op, payload) {
    const json = Buffer.from(JSON.stringify(payload), "utf8");
    const head = Buffer.alloc(8);
    head.writeInt32LE(op, 0);
    head.writeInt32LE(json.length, 4);
    this.sock.write(Buffer.concat([head, json]));
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (len < 0 || len > MAX_FRAME) return this.dropPeer(`frame de ${len} bytes`);
      if (this.buf.length < 8 + len) break;
      let body;
      try {
        body = JSON.parse(this.buf.subarray(8, 8 + len).toString("utf8"));
      } catch {
        return this.dropPeer("JSON inválido");
      }
      if (!body || typeof body !== "object") return this.dropPeer("frame não é objeto");
      this.buf = this.buf.subarray(8 + len);
      if (op === 3) {
        // Quem manda ping sem ler as respostas não enche a fila de saída.
        if (this.sock.writableLength > MAX_FRAME) return this.dropPeer("fila de saída cheia");
        this.send(4, body);
      }
      else if (op === 2) log("Discord fechou a conexão:", JSON.stringify(body));
      else if (body.evt === "READY") this.readyResolve?.();
      else if (body.nonce && this.pending.has(body.nonce)) {
        this.pending.get(body.nonce)(body);
        this.pending.delete(body.nonce);
      }
    }
  }

  dropPeer(reason) {
    log("resposta malformada do pipe, desconectando:", reason);
    this.buf = Buffer.alloc(0);
    this.sock?.destroy();
  }

  onClose() {
    this.ready = false;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    for (const done of this.pending.values()) done({ evt: "ERROR", data: { message: "conexão fechada" } });
    this.pending.clear();
  }

  setActivity(activity) {
    return new Promise((resolve) => {
      const nonce = String(++this.nonce);
      this.pending.set(nonce, resolve);
      this.send(1, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity }, nonce });
      // unref: no --once, a espera não segura o processo depois da resposta.
      setTimeout(() => {
        if (this.pending.delete(nonce)) resolve({ evt: "ERROR", data: { message: "sem resposta" } });
      }, 5000).unref();
    });
  }

  close() {
    this.sock?.destroy();
  }
}

// ---------- laço principal ----------

// Uma conexão por app do Discord: cada conexão carrega uma atividade só, e o título do card é o
// nome do app. O do T3 fica sempre conectado; o do Roblox só existe com um jogo aberto, e fechar a
// conexão tira o card dele do perfil.
const channels = { t3: { ipc: null, lastSent: undefined }, roblox: { ipc: null, lastSent: undefined } };
let reconnectWanted = false;
// O que a bandeja mostra: lido de presence.status.json a cada poucos segundos.
const status = { t3: false, discord: false, app: "", card: null, roblox: null, erro: "", pausado: false, projetos: [] };

function closeChannel(ch) {
  ch.ipc?.close();
  ch.ipc = null;
  ch.lastSent = undefined;
}

// Conecta se preciso e manda a atividade quando ela mudou. Devolve a resposta do Discord, "igual"
// quando não havia nada novo, ou null quando o Discord não atende.
async function publish(name, clientId, activity) {
  const ch = channels[name];
  if (!ch.ipc || ch.ipc.clientId !== clientId || !ch.ipc.ready) {
    closeChannel(ch);
    const ipc = new DiscordIpc(clientId);
    if (!(await ipc.connect())) return null;
    ch.ipc = ipc;
    log(`conectado ao Discord (${name})`);
  }
  const key = JSON.stringify(activity);
  if (key === ch.lastSent) return "igual";
  const res = await ch.ipc.setActivity(activity);
  if (res.evt === "ERROR") {
    log(`Discord recusou a atividade (${name}):`, JSON.stringify(res.data), "enviado:", key);
    status.erro = `Discord recusou: ${res.data?.message || "?"}`;
    return res;
  }
  ch.lastSent = key;
  log(`atividade (${name}):`, key, "| app:", res.data?.name);
  if (ARGS.has("--once")) console.log(`resposta do Discord (${name}):`, JSON.stringify(res.data));
  return res;
}

async function robloxActivity(cfg) {
  if (cfg.roblox?.ativo === false || !cfg.roblox?.clientId) return null;
  try {
    const session = readRobloxSession();
    if (!session) return null;
    return buildRobloxActivity(cfg, session, await robloxGame(cfg, session.universeId));
  } catch (e) {
    log("falha lendo o Roblox:", e.message);
    return null;
  }
}

async function tick() {
  const cfg = loadConfig();
  let activity = null;
  status.t3 = t3Running();
  status.erro = "";
  // Desligado pela bandeja: os cards saem do Discord e o programa segue aberto, até ligar de novo
  const pausado = cfg.ativo === false;
  if (pausado !== status.pausado) log(pausado ? "desligado pela bandeja" : "ligado pela bandeja");
  status.pausado = pausado;
  if (status.t3) listProjects();
  if (status.t3 && !pausado) {
    try {
      activity = buildActivity(cfg, { ...readState(cfg), awayMs: awayMs(cfg) });
    } catch (e) {
      log("falha lendo o estado do T3 (o formato do banco mudou?):", e.message);
      status.erro = "falha lendo o estado do T3";
      try {
        db?.close();
      } catch {}
      db = null;
      activity = null;
    }
  }
  const roblox = pausado ? null : await robloxActivity(cfg);

  if (ARGS.has("--dry")) {
    console.log(JSON.stringify(ARGS.has("--roblox") ? roblox : activity, null, 2));
    return;
  }

  if (reconnectWanted) {
    reconnectWanted = false;
    closeChannel(channels.t3);
    closeChannel(channels.roblox);
    log("reconectando a pedido da bandeja");
  }

  const res = await publish("t3", cfg.clientId, activity);
  if (!res) {
    closeChannel(channels.t3);
    closeChannel(channels.roblox);
    status.discord = false;
    status.erro ||= "Discord fechado ou sem resposta";
    return;
  }
  status.discord = true;
  if (res !== "igual" && res.evt !== "ERROR") {
    status.app = res.data?.name || status.app;
    status.card = activity && { tipo: activity.type, linha1: activity.details || "", linha2: activity.state || "" };
  }

  if (!roblox) {
    if (channels.roblox.ipc) log("card do Roblox saiu");
    closeChannel(channels.roblox);
    status.roblox = null;
  } else {
    const r = await publish("roblox", cfg.roblox.clientId, roblox);
    if (!r) closeChannel(channels.roblox);
    else if (r !== "igual" && r.evt !== "ERROR")
      status.roblox = { app: r.data?.name || "", linha1: roblox.details || "", linha2: roblox.state || "" };
  }
}

function writeStatus() {
  const out = { ...status, modo: config?.modoAtivo, intervalo: config?.intervaloSegundos, pid: process.pid, at: Date.now() };
  try {
    fs.writeFileSync(STATUS_PATH + ".tmp", JSON.stringify(out));
    fs.renameSync(STATUS_PATH + ".tmp", STATUS_PATH);
  } catch {}
}

// ---------- ícone na bandeja ----------

let wake = null;
// Comando que chega durante o tick() não acha o wake: fica marcado e o ciclo seguinte não espera.
let wakePending = false;

// O app da bandeja (app/, Tauri) desenha o ícone, o painel e as configurações; sem o exe
// compilado, o tray.ps1 faz o mesmo em WinForms. Os dois falam por linhas no stdout deles, e o
// app sai quando o stdin fecha, o que acontece quando este processo morre de qualquer jeito.
// Nos testes (pipe falso) ou com T3P_NO_TRAY, não abre.
// Instalado, o exe fica ao lado deste arquivo; no checkout de dev, onde o cargo build deixa.
const TRAY_EXE =
  [
    path.join(DIR, "quack-presence-tray.exe"),
    path.join(DIR, "app", "src-tauri", "target", "release", "quack-presence-tray.exe"),
  ].find((p) => fs.existsSync(p)) ?? "";

function startTray() {
  if (process.env.T3P_IPC_PIPE || process.env.T3P_NO_TRAY) return;
  let cmd, args;
  if (TRAY_EXE) {
    [cmd, args] = [TRAY_EXE, ["--dir", DIR]];
  } else {
    const ps = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden"];
    [cmd, args] = ["powershell.exe", [...ps, "-File", path.join(DIR, "tray.ps1"), String(process.pid)]];
  }
  log("bandeja:", path.basename(cmd));
  const child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", (e) => log("bandeja não abriu:", e.message));
  child.on("exit", (code) => log("bandeja fechou, código", code));
  child.stderr.on("data", (d) => log("bandeja:", d.toString().trim()));
  readline.createInterface({ input: child.stdout }).on("line", (line) => onTrayCommand(line.trim()));
}

async function onTrayCommand(line) {
  const [cmd] = line.split(" ", 1);
  const rest = line.slice(cmd.length).trim();
  try {
    if (cmd === "input") {
      inputIdleMs = Math.max(0, Number(rest) || 0);
      inputSeenAt = Date.now();
      // Chega a cada 2 s: só acorda o laço quando muda entre presente e ausente, senão o
      // intervalo vira 2 s. Na volta, o card troca na hora.
      const away = config ? awayMs(config) !== null : false;
      if (away === wasAway) return;
      wasAway = away;
    } else if (cmd === "quit") {
      await quit("pela bandeja");
    } else if (cmd === "reconnect") {
      reconnectWanted = true;
    } else if (cmd === "config") {
      patchConfig(JSON.parse(rest));
    } else return;
    wakePending = true;
    wake?.();
  } catch (e) {
    log("comando da bandeja falhou:", line, e.message);
  }
}

/** Limpa o card e sai: o Sair do painel, uma atualização ou o instalador (pela trava) */
async function quit(why) {
  log("saindo", why);
  // O Discord limpa o card quando a conexão cai; mandar null antes só deixa mais rápido.
  for (const ch of Object.values(channels)) {
    try {
      if (ch.ipc?.ready) await ch.ipc.setActivity(null);
    } catch {}
    closeChannel(ch);
  }
  try {
    fs.unlinkSync(STATUS_PATH);
  } catch {}
  process.exit(0);
}

/**
 * A trava de instância única: o Windows solta o pipe quando o processo morre, sem arquivo velho.
 * Quem se conecta e manda "quit" fecha este processo (o instalador, antes de trocar os arquivos).
 * Ocupada, tenta de novo por uns segundos: no fim de uma atualização o processo velho ainda pode
 * estar saindo.
 */
async function takeLock(name) {
  for (let attempt = 0; ; attempt++) {
    const locked = await new Promise((resolve) => {
      const lock = net.createServer((s) => {
        s.on("data", (d) => {
          if (d.toString().trim() === "quit") quit("pelo instalador");
        });
        s.on("error", () => {});
        s.setTimeout(2000, () => s.destroy());
      });
      lock.once("error", () => resolve(false));
      lock.listen(`\\\\?\\pipe\\${name}`, () => resolve(true));
    });
    if (locked || attempt >= 5) return locked;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  // A instalação traz só o config.default.json: o config.json é do usuário, e atualização nenhuma
  // passa por cima dele.
  if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(DEFAULT_CONFIG_PATH)) {
    fs.copyFileSync(DEFAULT_CONFIG_PATH, CONFIG_PATH);
  }
  if (ARGS.has("--once") || ARGS.has("--dry")) {
    await tick();
    if (ARGS.has("--once")) await new Promise((r) => setTimeout(r, 1500));
    for (const ch of Object.values(channels)) closeChannel(ch);
    return;
  }
  // Com o pipe falso dos testes a trava é outra, para o teste rodar junto com o programa em uso.
  const lockName = process.env.T3P_IPC_PIPE ? `quack-presence-lock-test-${process.pid}` : "quack-presence-lock";
  const locked = await takeLock(lockName);
  if (!locked) {
    console.log("já está rodando");
    return;
  }
  log("iniciado, pid", process.pid);
  startTray();
  for (;;) {
    wakePending = false;
    try {
      await tick();
    } catch (e) {
      log("erro:", e.stack || e.message);
      status.erro = e.message;
    }
    writeStatus();
    if (wakePending) continue;
    // Teto de 1 h: acima do limite do setTimeout (~24,8 dias) o Node troca a espera por 1 ms.
    // Um comando da bandeja (config salvo, reconectar) acorda antes.
    const secs = Math.min(3600, Math.max(3, Number(config?.intervaloSegundos) || 5));
    await new Promise((r) => {
      const t = setTimeout(r, secs * 1000);
      wake = () => {
        clearTimeout(t);
        r();
      };
    });
    wake = null;
  }
}

// Os testes importam o arquivo para chamar o patchText sem abrir o programa.
export { patchText };
if (!process.env.T3P_IMPORT) main();
