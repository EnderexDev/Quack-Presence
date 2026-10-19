// Testes da rodada 3. Uso: node tests/review-3.mjs [pasta do presence] (programa parado: a cópia precisa da trava)
import { DatabaseSync } from "node:sqlite";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.argv[2] || path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(APP, "presence.mjs");
const alivePid = Number(spawnSync("powershell", ["-NoProfile", "-c", "(Get-Process Discord)[0].Id"]).stdout.toString().trim());
const iso = (hAgo) => new Date(Date.now() - hAgo * 3600_000).toISOString();

// Achado 1: run iniciada há 30h e concluída há 5 min, sem outras runs: não pode estar ocioso.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-"));
  fs.mkdirSync(path.join(home, "userdata"));
  fs.writeFileSync(path.join(home, "userdata", "server-runtime.json"), JSON.stringify({ pid: alivePid }));
  const db = new DatabaseSync(path.join(home, "userdata", "statev2.sqlite"));
  db.exec(`CREATE TABLE orchestration_v2_projection_runs (run_id, thread_id, status, requested_at, completed_at, payload_json);
    CREATE TABLE orchestration_v2_projection_threads (thread_id, project_id, title);
    CREATE TABLE projection_projects (project_id, title);
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id, run_id, type, status, updated_at, ordinal);
    INSERT INTO orchestration_v2_projection_threads VALUES ('t1','p1','T');
    INSERT INTO projection_projects VALUES ('p1','Projeto X');`);
  db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?,?,'{}')").run("A", "t1", "completed", iso(30), iso(5 / 60));
  db.close();
  const out = spawnSync("node", ["--no-warnings", SCRIPT, "--dry"], { env: { ...process.env, T3CODE_HOME: home } }).stdout.toString();
  const json = out.split("\n").filter((l) => !l.startsWith("[")).join("\n").trim();
  const ok = json !== "null" && json.includes("Projeto X");
  console.log(`achado 1 (run longa recém-concluída não é ociosa): ${ok ? "OK" : "FALHOU"} ${ok ? "" : json}`);
}

// Achado 3: intervaloSegundos gigante numa cópia rodando por 8 s, sem TimeoutOverflowWarning.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-int-"));
  fs.copyFileSync(SCRIPT, path.join(dir, "presence.mjs"));
  const cfg = JSON.parse(fs.readFileSync(path.join(APP, "config.json"), "utf8"));
  cfg.intervaloSegundos = 1e10;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));
  const child = spawn("node", [path.join(dir, "presence.mjs")], { env: { ...process.env, T3P_IPC_PIPE: "\\\\?\\pipe\\t3p-nada" } });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  await new Promise((r) => setTimeout(r, 8000));
  const alive = child.exitCode === null;
  child.kill();
  const ok = alive && !err.includes("TimeoutOverflowWarning");
  console.log(`achado 3 (intervalo gigante): ${ok ? "OK" : "FALHOU"} vivo=${alive}`, ok ? "" : err.slice(0, 300));
}
