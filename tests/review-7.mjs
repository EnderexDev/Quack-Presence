// Ocioso do T3 e longe do PC aparecem no card em vez de esconder. Uso: node tests/review-7.mjs [pasta do presence]
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.argv[2] || path.resolve(import.meta.dirname, "..");
// O próprio teste faz o papel do T3 rodando: está vivo enquanto o --dry roda, com ou sem Discord.
const alivePid = process.pid;
const iso = (minAgo) => new Date(Date.now() - minAgo * 60_000).toISOString();
// Pastas temporárias saem no fim mesmo quando o teste lança no meio.
const tmpDirs = [];
const mkTmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};
process.on("exit", () => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});
const parse = (out) => JSON.parse(out.split("\n").filter((l) => !l.startsWith("[")).join("\n"));

// T3 com uma run: rodando (ativo) ou concluída há 30 min (ocioso, com ociosoMinutos 15).
function makeHome(running) {
  const home = mkTmp("t3p-");
  fs.mkdirSync(path.join(home, "userdata"));
  fs.writeFileSync(path.join(home, "userdata", "server-runtime.json"), JSON.stringify({ pid: alivePid }));
  const db = new DatabaseSync(path.join(home, "userdata", "statev2.sqlite"));
  db.exec(`CREATE TABLE orchestration_v2_projection_runs (run_id, thread_id, status, requested_at, completed_at, payload_json);
    CREATE TABLE orchestration_v2_projection_threads (thread_id, project_id, title);
    CREATE TABLE projection_projects (project_id, title);
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id, run_id, type, status, updated_at, ordinal);
    INSERT INTO orchestration_v2_projection_threads VALUES ('t1','p1','T');
    INSERT INTO projection_projects VALUES ('p1','Projeto X');`);
  db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES ('A','t1',?,?,?,'{}')").run(
    running ? "running" : "completed",
    iso(running ? 5 : 40),
    running ? null : iso(30),
  );
  db.close();
  return home;
}

const cdir = mkTmp("t3p-cfg-");
fs.copyFileSync(path.join(APP, "presence.mjs"), path.join(cdir, "presence.mjs"));
const cfg = JSON.parse(fs.readFileSync(path.join(APP, "config.json"), "utf8"));
Object.assign(cfg, {
  modoAtivo: "normal",
  mostrar: { projeto: true, atividade: true, timer: true },
  ociosoMinutos: 15,
  quandoOcioso: "mostrar",
  textoOcioso: "OCIOSO",
  ausenteMinutos: 5,
  textoAusente: "Longe há {tempo}",
  seguirUltimaMensagem: false,
});
fs.writeFileSync(path.join(cdir, "config.json"), JSON.stringify(cfg));

function dry(home, idleMs) {
  const env = { ...process.env, T3CODE_HOME: home };
  delete env.T3P_IDLE_MS;
  if (idleMs !== undefined) env.T3P_IDLE_MS = String(idleMs);
  return parse(spawnSync("node", ["--no-warnings", path.join(cdir, "presence.mjs"), "--dry"], { env }).stdout.toString());
}

const ativo = makeHome(true);
const ocioso = makeHome(false);
const cases = [
  ["T3 ocioso mostra o card, sem timer", dry(ocioso), (a) => a?.state === "OCIOSO" && !a.timestamps],
  ["sem notícia da bandeja conta como presente", dry(ativo), (a) => a?.state !== undefined && !a.state.startsWith("Longe")],
  ["abaixo do limite conta como presente", dry(ativo, 4 * 60_000), (a) => typeof a?.state === "string" && !a.state.startsWith("Longe")],
  ["longe com T3 rodando, timer segue", dry(ativo, 12 * 60_000), (a) => a?.state === "Longe há 12 min" && a.timestamps],
  ["longe vence o ocioso do T3", dry(ocioso, 65 * 60_000), (a) => a?.state === "Longe há 1 h 5 min"],
  ["projeto continua na linha 1", dry(ativo, 12 * 60_000), (a) => a?.details === "Programando · Projeto X"],
];
for (const [name, act, check] of cases) {
  const ok = check(act);
  if (!ok) process.exitCode = 1;
  console.log(`${name}: ${ok ? "OK" : "FALHOU"} state=${act?.state}`);
}
