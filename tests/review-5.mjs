// Sessão aberta = última mensagem do usuário. Uso: node tests/review-5.mjs [pasta do presence]
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.argv[2] || path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(APP, "presence.mjs");
const alivePid = Number(spawnSync("powershell", ["-NoProfile", "-c", "(Get-Process Discord)[0].Id"]).stdout.toString().trim());
const iso = (mAgo) => new Date(Date.now() - mAgo * 60_000).toISOString();

// Cenário: 3 projetos. A roda (mexeu agora), B é o do meio e não foi tocado, C recebeu a última mensagem.
function run(cRunning, extraCfg = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-"));
  fs.mkdirSync(path.join(home, "userdata"));
  fs.writeFileSync(path.join(home, "userdata", "server-runtime.json"), JSON.stringify({ pid: alivePid }));
  const db = new DatabaseSync(path.join(home, "userdata", "statev2.sqlite"));
  db.exec(`CREATE TABLE orchestration_v2_projection_runs (run_id, thread_id, status, requested_at, completed_at, payload_json);
    CREATE TABLE orchestration_v2_projection_threads (thread_id, project_id, title);
    CREATE TABLE projection_projects (project_id, title);
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id, run_id, type, status, updated_at, ordinal);
    INSERT INTO orchestration_v2_projection_threads VALUES ('ta','pa','TA'), ('tb','pb','TB'), ('tc','pc','TC');
    INSERT INTO projection_projects VALUES ('pa','Projeto A'), ('pb','Projeto B'), ('pc','Projeto C');`);
  const ins = db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?,?,'{}')");
  ins.run("A", "ta", "running", iso(20), null);
  ins.run("B", "tb", "completed", iso(15), iso(12));
  ins.run("C", "tc", cRunning ? "running" : "completed", iso(3), cRunning ? null : iso(1));
  const it = db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?)");
  it.run("ta", "A", "user_message", "completed", iso(20), 1);
  it.run("tb", "B", "user_message", "completed", iso(15), 1);
  it.run("tc", "C", "user_message", "completed", iso(3), 1);
  it.run("ta", "A", "file_change", "running", iso(0), 2);
  if (cRunning) it.run("tc", "C", "web_search", "running", iso(0.5), 2);
  db.close();
  const cfg = JSON.parse(fs.readFileSync(path.join(APP, "config.json"), "utf8"));
  Object.assign(cfg, { modoAtivo: "normal" }, extraCfg);
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-cfg-"));
  fs.copyFileSync(SCRIPT, path.join(cdir, "presence.mjs"));
  fs.writeFileSync(path.join(cdir, "config.json"), JSON.stringify(cfg));
  const out = spawnSync("node", ["--no-warnings", path.join(cdir, "presence.mjs"), "--dry"], {
    env: { ...process.env, T3CODE_HOME: home },
  }).stdout.toString();
  return JSON.parse(out.split("\n").filter((l) => !l.startsWith("[")).join("\n"));
}

const check = (label, act, details, state) => {
  const ok = act?.details === details && act?.state === state;
  console.log(`${label}: ${ok ? "OK" : "FALHOU"} details=${act?.details} state=${act?.state}`);
};
check("C parada, A rodando", run(false), "Programando · Projeto C", "Revisando");
check("C rodando", run(true), "Programando · Projeto C", "Pesquisando");
check("desligado volta ao antigo", run(false, { seguirUltimaMensagem: false }), "Programando · Projeto A", "Editando código");
check("C ignorado cai na próxima (B)", run(false, { projetos: { "Projeto C": { ignorar: true } } }), "Programando · Projeto B", "Revisando");
