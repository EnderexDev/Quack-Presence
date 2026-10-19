// Testes das correções da revisão. Uso: node tests/review-1.mjs [pasta do presence]
import { DatabaseSync } from "node:sqlite";
import { spawnSync, spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.argv[2] || path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(APP, "presence.mjs");
const alivePid = Number(spawnSync("powershell", ["-NoProfile", "-c", "(Get-Process Discord)[0].Id"]).stdout.toString().trim());

function fakeHome(withTables, runs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-"));
  fs.mkdirSync(path.join(home, "userdata"));
  fs.writeFileSync(path.join(home, "userdata", "server-runtime.json"), JSON.stringify({ pid: alivePid }));
  const db = new DatabaseSync(path.join(home, "userdata", "statev2.sqlite"));
  if (withTables) {
    db.exec(`CREATE TABLE orchestration_v2_projection_runs (run_id, thread_id, status, requested_at, completed_at, payload_json);
      CREATE TABLE orchestration_v2_projection_threads (thread_id, project_id, title);
      CREATE TABLE projection_projects (project_id, title);
      CREATE TABLE orchestration_v2_projection_turn_items (thread_id, run_id, type, status, updated_at, ordinal);
      INSERT INTO orchestration_v2_projection_threads VALUES ('t1','p1','Thread'), ('t2','p1','Thread 2');
      INSERT INTO projection_projects VALUES ('p1','Projeto X');`);
    const ins = db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?,?,'{}')");
    for (const r of runs) ins.run(...r);
  }
  db.close();
  return home;
}

const iso = (hAgo) => new Date(Date.now() - hAgo * 3600_000).toISOString();
const dry = (home) => {
  const out = spawnSync("node", ["--no-warnings", SCRIPT, "--dry"], { env: { ...process.env, T3CODE_HOME: home } });
  return { stdout: out.stdout.toString(), code: out.status };
};

// Achado 2: run antiga ainda rodando + run mais nova que acabou há 1h.
{
  const home = fakeHome(true, [
    ["A", "t1", "running", iso(3), null],
    ["B", "t2", "completed", iso(2), iso(1)],
  ]);
  const act = JSON.parse(dry(home).stdout.split("\n").filter((l) => !l.startsWith("[")).join("\n"));
  const start = act?.timestamps?.start;
  const ok = start && Math.abs(start - Date.parse(iso(3))) < 60_000;
  console.log(`achado 2 (timer com run antiga rodando): ${ok ? "OK" : "FALHOU"} start=${start && new Date(start).toISOString()}`);
}

// Achado 5: banco sem as tabelas cai no caminho de erro, fecha a conexão e não trava.
{
  const home = fakeHome(false, []);
  const r = dry(home);
  const ok = r.code === 0 && r.stdout.includes("formato do banco mudou") && r.stdout.trim().endsWith("null");
  console.log(`achado 5 (erro de banco tratado): ${ok ? "OK" : "FALHOU"} code=${r.code}`);
}

// Achados 3 e 4: pipe falso que manda frame gigante e depois JSON inválido.
async function fakePeer(name, payload) {
  const pipe = `\\\\?\\pipe\\${name}`;
  const server = net.createServer((s) => s.write(payload));
  await new Promise((r) => server.listen(pipe, r));
  // spawn assíncrono: spawnSync travaria este processo e o pipe falso nunca aceitaria a conexão.
  const child = spawn("node", ["--no-warnings", SCRIPT, "--once"], { env: { ...process.env, T3P_IPC_PIPE: pipe } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("exit", r));
  server.close();
  return { out, code };
}
{
  const head = Buffer.alloc(8);
  head.writeInt32LE(1, 0);
  head.writeInt32LE(2_000_000_000, 4);
  const r = await fakePeer("t3p-test-big", head);
  const ok = r.code === 0 && r.out.includes("frame de 2000000000 bytes");
  console.log(`achado 3a (frame gigante): ${ok ? "OK" : "FALHOU"} code=${r.code}`, ok ? "" : r.out);
}
{
  const body = Buffer.from("{nao é json", "utf8");
  const head = Buffer.alloc(8);
  head.writeInt32LE(1, 0);
  head.writeInt32LE(body.length, 4);
  const r = await fakePeer("t3p-test-bad", Buffer.concat([head, body]));
  const ok = r.code === 0 && r.out.includes("JSON inválido") && !r.out.includes("SyntaxError");
  console.log(`achado 3b (JSON inválido sem derrubar): ${ok ? "OK" : "FALHOU"} code=${r.code}`);
}
