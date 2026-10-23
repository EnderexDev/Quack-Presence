// Card do Roblox: log do Player e API falsos, Discord falso no pipe. Uso: node tests/review-8.mjs [pasta do presence]
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.argv[2] || path.resolve(import.meta.dirname, "..");
const tmpDirs = [];
const mkTmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};
let child = null;
process.on("exit", () => {
  child?.kill();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});
let fails = 0;
const check = (name, ok, extra = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "OK  " : "FALHA"} ${name}${extra ? " | " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// API falsa: o universo 111 existe, o 222 dá erro 500.
const api = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const id = u.searchParams.get("universeIds");
  if (id !== "111") return res.writeHead(500).end();
  res.writeHead(200, { "content-type": "application/json" });
  if (u.pathname === "/games") res.end(JSON.stringify({ data: [{ name: "Jogo Um", playing: 1234, creator: { name: "Estúdio" } }] }));
  else res.end(JSON.stringify({ data: [{ state: "Completed", imageUrl: "https://img.test/um.png" }] }));
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const API = `http://127.0.0.1:${api.address().port}`;

// Pasta do presence com o config do repo, intervalo mínimo.
const cdir = mkTmp("t3p-rbx-");
fs.copyFileSync(path.join(APP, "presence.mjs"), path.join(cdir, "presence.mjs"));
const cfg = JSON.parse(fs.readFileSync(path.join(APP, "config.json"), "utf8"));
cfg.intervaloSegundos = 3;
cfg.jogos = [];
fs.writeFileSync(path.join(cdir, "config.json"), JSON.stringify(cfg));
const robloxId = cfg.roblox.clientId;

const logs = mkTmp("t3p-rbx-logs-");
const logFile = path.join(logs, "0.744.0_20261023T100000Z_Player_AB12C_last.log");
const ts = (sec) => new Date(Date.UTC(2026, 9, 23, 10, 0, sec)).toISOString();
const join = (sec, job, place, universe, referral) =>
  `${ts(sec)},1.0,1,6 [FLog::Output] ! Joining game '${job}' place ${place} at 10.0.0.1\n` +
  `${ts(sec)},1.0,1,6 [FLog::GameJoinLoadTime] Report game_join_loadtime: placeid:${place}, join_time:0.5, universeid:${universe}, referral_page:${referral}, sid:x, \n`;
const native = (sec) => `${ts(sec)},1.0,1,6 [FLog::SingleSurfaceApp] setStage: (stage:Native)\n`;

const baseEnv = { ...process.env, T3P_ROBLOX_LOGS: logs, T3P_ROBLOX_API: API, T3CODE_HOME: mkTmp("t3p-home-"), T3P_NO_TRAY: "1" };
// Só para casos que não chamam a API falsa: spawnSync trava este processo e ela não responderia.
const dry = (env) => {
  const out = spawnSync("node", ["--no-warnings", path.join(cdir, "presence.mjs"), "--dry", "--roblox"], { env: { ...baseEnv, ...env } });
  return JSON.parse(out.stdout.toString().split("\n").filter((l) => !l.startsWith("[")).join("\n"));
};

// ---------- --dry ----------
fs.writeFileSync(logFile, native(0) + join(1, "aaaa-1", "500", "111", "Home"));
// Log do CrashHandler mais novo não conta como sessão.
fs.writeFileSync(path.join(logs, "0.744.0_20261023T110000Z_Player_FF00F_CrashHandler_last.log"), "nada\n");

const a = await (async () => {
  const p = spawn("node", ["--no-warnings", path.join(cdir, "presence.mjs"), "--dry", "--roblox"], { env: { ...baseEnv, T3P_ROBLOX_RUNNING: "1" } });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  // close, não exit: o exit pode chegar antes do stdout terminar.
  await new Promise((r) => p.on("close", r));
  return JSON.parse(out.split("\n").filter((l) => !l.startsWith("[")).join("\n"));
})();
check("jogo público: nome na linha 1", a?.details === "Jogo Um", a?.details);
check("jogo público: jogadores com milhar", a?.state === "👥 1.234", a?.state);
check("jogo público: tipo Jogando e lista de membros na linha 1", a?.type === 0 && a?.status_display_type === 2);
check("jogo público: ícone e criador", a?.assets?.large_image === "https://img.test/um.png" && a?.assets?.large_text === "por Estúdio");
check(
  "jogo público: botão de entrar no servidor e de ver o jogo",
  a?.buttons?.length === 2 && a.buttons[0].url.endsWith("placeId=500&gameInstanceId=aaaa-1") && a.buttons[1].url.endsWith("/games/500"),
  JSON.stringify(a?.buttons),
);
check("timer desde a entrada", a?.timestamps?.start === Date.parse(ts(1)));
check("Roblox fechado: sem card", dry({ T3P_ROBLOX_RUNNING: "0" }) === null);

// ---------- laço real com Discord falso ----------
// Cada conexão guarda o client_id do handshake e as atividades que recebeu.
const conns = [];
const pipeName = `t3p-test-rbx-${process.pid}`;
const pipe = `\\\\?\\pipe\\${pipeName}`;
const discord = net.createServer((s) => {
  const c = { clientId: null, acts: [], open: true };
  conns.push(c);
  let buf = Buffer.alloc(0);
  const send = (op, body) => {
    const j = Buffer.from(JSON.stringify(body));
    const h = Buffer.alloc(8);
    h.writeInt32LE(op, 0);
    h.writeInt32LE(j.length, 4);
    s.write(Buffer.concat([h, j]));
  };
  s.on("close", () => (c.open = false));
  s.on("error", () => {});
  s.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const len = buf.readInt32LE(4);
      if (buf.length < 8 + len) break;
      const body = JSON.parse(buf.subarray(8, 8 + len));
      buf = buf.subarray(8 + len);
      if (body.client_id) {
        c.clientId = body.client_id;
        send(1, { evt: "READY", data: {} });
      } else if (body.cmd === "SET_ACTIVITY") {
        c.acts.push(body.args.activity);
        send(1, { cmd: "SET_ACTIVITY", nonce: body.nonce, data: { name: c.clientId === robloxId ? "Roblox" : "T3" } });
      }
    }
  });
});
await new Promise((r) => discord.listen(pipe, r));
const rbxConn = () => conns.filter((c) => c.clientId === robloxId).at(-1);
const waitFor = async (what, fn, ms = 12_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(200);
  }
  console.log(`  (esperando: ${what})`);
  return false;
};

fs.writeFileSync(logFile, native(0) + join(1, "aaaa-1", "500", "111", "Home"));
child = spawn("node", ["--no-warnings", path.join(cdir, "presence.mjs")], {
  env: { ...baseEnv, T3P_IPC_PIPE: pipe, T3P_ROBLOX_RUNNING: "1" },
});
child.stderr.on("data", (d) => process.stderr.write(d));

await waitFor("card do Roblox", () => rbxConn()?.acts.length);
const t3 = conns.find((c) => c.clientId === cfg.clientId);
check("duas conexões: T3 e Roblox, cada uma com o seu app", !!t3 && !!rbxConn());
const first = rbxConn()?.acts.at(-1);
check("laço: card do Roblox com o jogo", first?.details === "Jogo Um", first?.details);

// Teleporte no mesmo jogo: servidor novo no botão, mesmo início no timer.
fs.appendFileSync(logFile, join(30, "bbbb-2", "501", "111", ""));
await waitFor("teleporte", () => rbxConn()?.acts.at(-1)?.buttons?.[0]?.url.includes("bbbb-2"));
const tele = rbxConn()?.acts.at(-1);
check("teleporte: botão aponta para o servidor novo", !!tele?.buttons?.[0]?.url.includes("placeId=501&gameInstanceId=bbbb-2"));
check("teleporte: timer continua o da entrada", tele?.timestamps?.start === Date.parse(ts(1)));

// Volta para o app: o card do Roblox sai (a conexão fecha), o do T3 continua.
fs.appendFileSync(logFile, native(60));
await waitFor("conexão do Roblox fechar", () => rbxConn() && !rbxConn().open);
check("fora de jogo: conexão do Roblox fechada", rbxConn() && !rbxConn().open);
check("fora de jogo: conexão do T3 segue aberta", t3?.open === true);

// Servidor privado num jogo cuja API falha: só "Ver jogo", nome genérico, linha de jogadores some.
fs.appendFileSync(logFile, join(90, "cccc-3", "900", "222", "RequestPrivateGame"));
await waitFor("card do jogo privado", () => rbxConn()?.open && rbxConn().acts.length);
const priv = rbxConn()?.acts.at(-1);
check("privado: sem botão de entrar", priv?.buttons?.length === 1 && priv.buttons[0].url.endsWith("/games/900"), JSON.stringify(priv?.buttons));
check("API fora: nome genérico e sem linha de jogadores", priv?.details === "Roblox" && priv?.state === undefined, JSON.stringify(priv));
check("privado: timer novo (outro jogo)", priv?.timestamps?.start === Date.parse(ts(90)));

child.kill();
child = null;
discord.close();
api.close();
console.log(fails ? `${fails} falha(s)` : "tudo certo");
process.exit(fails ? 1 : 0);
