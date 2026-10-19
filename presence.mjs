// Discord Rich Presence para o T3 Code.
// Lê o estado do T3 (statev2.sqlite, só leitura) e publica no Discord pelo IPC local.
// Uso: node presence.mjs            (roda para sempre)
//      node presence.mjs --once     (publica uma vez, imprime o que mandou e sai)
//      node presence.mjs --dry      (só imprime a atividade calculada, sem Discord)
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(DIR, "config.json");
const LOG_PATH = path.join(DIR, "presence.log");
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
    .prepare(`SELECT ${RUN_COLS} ${RUN_JOIN} WHERE r.requested_at >= ? ORDER BY r.requested_at DESC`)
    .all(new Date(Date.now() - 24 * 3600_000).toISOString());

  const ignored = (run) => cfg.projetos?.[run.project_title]?.ignorar === true;
  const activeRuns = running.filter((r) => !ignored(r));
  const recentRuns = recent.filter((r) => !ignored(r));

  // Run em foco: entre as que rodam, a que mexeu por último.
  const itemStmt = d.prepare(`SELECT type, status, updated_at FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ? AND run_id = ? ORDER BY ordinal DESC LIMIT 8`);
  let focus = null;
  let focusItem = null;
  for (const run of activeRuns) {
    const items = itemStmt.all(run.thread_id, run.run_id);
    const item = items.find((i) => i.status === "running") || items[0] || null;
    const touched = item?.updated_at || run.requested_at;
    if (!focus || touched > (focusItem?.updated_at || focus.requested_at)) {
      focus = run;
      focusItem = item;
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
  const last = focus || recentRuns[0] || null;
  return { idle, focus, focusItem, last, agents: activeRuns.length, blockStart };
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

function buildActivity(cfg, state) {
  if (state.idle && cfg.quandoOcioso !== "mostrar") return null;
  const show = cfg.mostrar || {};
  const run = state.last;
  const projCfg = cfg.projetos?.[run?.project_title] || {};
  const privado = projCfg.privado === true;

  let atividade = "";
  if (state.idle) atividade = cfg.textoOcioso || "";
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
    type: TYPES[cfg.tipo] ?? 0,
    details: clamp(fill(mode.linha1, values)),
    state: clamp(fill(mode.linha2, values)),
    instance: false,
  };
  if (cfg.textoNaListaDeMembros in DISPLAY) activity.status_display_type = DISPLAY[cfg.textoNaListaDeMembros];

  if (show.timer !== false && state.blockStart && !state.idle) activity.timestamps = { start: state.blockStart };

  const img = { ...(cfg.imagem || {}), ...(projCfg.imagem ? { grande: projCfg.imagem } : {}) };
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
        setTimeout(() => !this.ready && fail(new Error("sem READY")), 5000);
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
      setTimeout(() => {
        if (this.pending.delete(nonce)) resolve({ evt: "ERROR", data: { message: "sem resposta" } });
      }, 5000);
    });
  }

  close() {
    this.sock?.destroy();
  }
}

// ---------- laço principal ----------

let ipc = null;
let lastSent = undefined;

async function tick() {
  const cfg = loadConfig();
  let activity = null;
  if (t3Running()) {
    try {
      activity = buildActivity(cfg, readState(cfg));
    } catch (e) {
      log("falha lendo o estado do T3 (o formato do banco mudou?):", e.message);
      try {
        db?.close();
      } catch {}
      db = null;
      activity = null;
    }
  }

  if (ARGS.has("--dry")) {
    console.log(JSON.stringify(activity, null, 2));
    return;
  }

  if (!ipc || ipc.clientId !== cfg.clientId || !ipc.ready) {
    ipc?.close();
    ipc = new DiscordIpc(cfg.clientId);
    if (!(await ipc.connect())) {
      ipc = null;
      return;
    }
    log("conectado ao Discord");
    lastSent = undefined;
  }

  const key = JSON.stringify(activity);
  if (key === lastSent) return;
  const res = await ipc.setActivity(activity);
  if (res.evt === "ERROR") {
    log("Discord recusou a atividade:", JSON.stringify(res.data), "enviado:", key);
    return;
  }
  lastSent = key;
  log("atividade:", key);
  if (ARGS.has("--once")) console.log("resposta do Discord:", JSON.stringify(res.data));
}

async function main() {
  if (ARGS.has("--once") || ARGS.has("--dry")) {
    await tick();
    if (ARGS.has("--once")) await new Promise((r) => setTimeout(r, 1500));
    ipc?.close();
    return;
  }
  // Trava de instância única: o Windows solta o pipe quando o processo morre, sem arquivo velho.
  const locked = await new Promise((resolve) => {
    const lock = net.createServer((s) => s.destroy());
    lock.once("error", () => resolve(false));
    lock.listen("\\\\?\\pipe\\t3-presence-lock", () => resolve(true));
  });
  if (!locked) {
    console.log("já está rodando");
    return;
  }
  log("iniciado, pid", process.pid);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      log("erro:", e.stack || e.message);
    }
    const secs = Math.max(3, Number(config?.intervaloSegundos) || 5);
    await new Promise((r) => setTimeout(r, secs * 1000));
  }
}

main();
