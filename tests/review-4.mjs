// Testes da rodada 4. Uso: node tests/review-4.mjs [pasta do presence]
import { DatabaseSync } from "node:sqlite";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.argv[2] || path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(APP, "presence.mjs");
const alivePid = Number(spawnSync("powershell", ["-NoProfile", "-c", "(Get-Process Discord)[0].Id"]).stdout.toString().trim());
const iso = (hAgo) => new Date(Date.now() - hAgo * 3600_000).toISOString();
const parse = (out) => JSON.parse(out.split("\n").filter((l) => !l.startsWith("[")).join("\n"));

// Achado 3: A pedida antes e concluída depois de B. Entre tarefas, o projeto tem que ser o de A.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-"));
  fs.mkdirSync(path.join(home, "userdata"));
  fs.writeFileSync(path.join(home, "userdata", "server-runtime.json"), JSON.stringify({ pid: alivePid }));
  const db = new DatabaseSync(path.join(home, "userdata", "statev2.sqlite"));
  db.exec(`CREATE TABLE orchestration_v2_projection_runs (run_id, thread_id, status, requested_at, completed_at, payload_json);
    CREATE TABLE orchestration_v2_projection_threads (thread_id, project_id, title);
    CREATE TABLE projection_projects (project_id, title);
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id, run_id, type, status, updated_at, ordinal);
    INSERT INTO orchestration_v2_projection_threads VALUES ('t1','p1','T1'), ('t2','p2','T2');
    INSERT INTO projection_projects VALUES ('p1','Projeto A'), ('p2','Projeto B');`);
  const ins = db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?,?,'{}')");
  ins.run("A", "t1", "completed", iso(2), iso(2 / 60));
  ins.run("B", "t2", "completed", iso(1), iso(10 / 60));
  db.close();
  const act = parse(spawnSync("node", ["--no-warnings", SCRIPT, "--dry"], { env: { ...process.env, T3CODE_HOME: home } }).stdout.toString());
  const ok = act?.state === "Projeto A";
  console.log(`achado 3 (projeto da última concluída): ${ok ? "OK" : "FALHOU"} state=${act?.state}`);
}

// Achado 1: processo real chamado "a,b.exe" na lista de jogos.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-exe-"));
  const exe = path.join(dir, "a,b.exe");
  fs.copyFileSync(process.execPath, exe);
  const game = spawn(exe, ["-e", "setTimeout(()=>{},20000)"]);
  await new Promise((r) => setTimeout(r, 1500));
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-cfg-"));
  fs.copyFileSync(SCRIPT, path.join(cdir, "presence.mjs"));
  const cfg = JSON.parse(fs.readFileSync(path.join(APP, "config.json"), "utf8"));
  cfg.jogos = ["a,b.exe"];
  fs.writeFileSync(path.join(cdir, "config.json"), JSON.stringify(cfg));
  const act = parse(spawnSync("node", ["--no-warnings", path.join(cdir, "presence.mjs"), "--dry"]).stdout.toString());
  game.kill();
  const ok = act?.type === 3;
  console.log(`achado 1 (exe com vírgula detectado): ${ok ? "OK" : "FALHOU"} type=${act?.type}`);
}
