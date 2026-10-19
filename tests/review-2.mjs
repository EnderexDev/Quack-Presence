// Testes da rodada 2 da revisão. Uso: node tests/review-2.mjs [pasta do presence] (programa rodando: testa a trava)
import { DatabaseSync } from "node:sqlite";
import { spawnSync, spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.argv[2] || path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(APP, "presence.mjs");
const alivePid = Number(spawnSync("powershell", ["-NoProfile", "-c", "(Get-Process Discord)[0].Id"]).stdout.toString().trim());
const iso = (hAgo) => new Date(Date.now() - hAgo * 3600_000).toISOString();

// Achado 1: run rodando desde 30h atrás + run nova concluída há 5 min.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-"));
  fs.mkdirSync(path.join(home, "userdata"));
  fs.writeFileSync(path.join(home, "userdata", "server-runtime.json"), JSON.stringify({ pid: alivePid }));
  const db = new DatabaseSync(path.join(home, "userdata", "statev2.sqlite"));
  db.exec(`CREATE TABLE orchestration_v2_projection_runs (run_id, thread_id, status, requested_at, completed_at, payload_json);
    CREATE TABLE orchestration_v2_projection_threads (thread_id, project_id, title);
    CREATE TABLE projection_projects (project_id, title);
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id, run_id, type, status, updated_at, ordinal);
    INSERT INTO orchestration_v2_projection_threads VALUES ('t1','p1','T'), ('t2','p1','T2');
    INSERT INTO projection_projects VALUES ('p1','Projeto X');`);
  const ins = db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?,?,'{}')");
  ins.run("A", "t1", "running", iso(30), null);
  ins.run("B", "t2", "completed", iso(1), iso(5 / 60));
  db.close();
  const out = spawnSync("node", ["--no-warnings", SCRIPT, "--dry"], { env: { ...process.env, T3CODE_HOME: home } }).stdout.toString();
  const act = JSON.parse(out.split("\n").filter((l) => !l.startsWith("[")).join("\n"));
  const start = act?.timestamps?.start;
  const ok = start && Math.abs(start - Date.parse(iso(30))) < 60_000;
  console.log(`achado 1 (run de 30h no timer): ${ok ? "OK" : "FALHOU"} start=${start && new Date(start).toISOString()}`);
}

async function fakePeer(name, onConn) {
  const pipe = `\\\\?\\pipe\\${name}`;
  const server = net.createServer(onConn);
  await new Promise((r) => server.listen(pipe, r));
  const child = spawn("node", ["--no-warnings", SCRIPT, "--once"], { env: { ...process.env, T3P_IPC_PIPE: pipe } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("exit", r));
  server.close();
  return { out, code };
}
const frame = (op, text) => {
  const body = Buffer.from(text, "utf8");
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

// Achado 3: frame com JSON null.
{
  const r = await fakePeer("t3p-test-null", (s) => s.write(frame(1, "null")));
  const ok = r.code === 0 && r.out.includes("frame não é objeto") && !r.out.includes("TypeError");
  console.log(`achado 3 (frame null): ${ok ? "OK" : "FALHOU"} code=${r.code}`, ok ? "" : r.out);
}

// Achado 2: pings de ~900 KB sem nunca ler as respostas.
{
  const ping = frame(3, JSON.stringify({ x: "a".repeat(900_000) }));
  const r = await fakePeer("t3p-test-ping", (s) => {
    s.on("error", () => {});
    s.pause();
    for (let i = 0; i < 20; i++) s.write(ping);
  });
  const ok = r.code === 0 && r.out.includes("fila de saída cheia");
  console.log(`achado 2 (enxurrada de ping): ${ok ? "OK" : "FALHOU"} code=${r.code}`, ok ? "" : r.out);
}

// Achado 4: conexão na trava do daemon é fechada pelo outro lado.
{
  const closed = await new Promise((resolve) => {
    const c = net.createConnection("\\\\?\\pipe\\t3-presence-lock");
    c.on("error", () => resolve("erro"));
    c.on("close", () => resolve("fechada"));
    setTimeout(() => resolve("aberta após 3s"), 3000);
  });
  console.log(`achado 4 (trava fecha conexões): ${closed === "fechada" ? "OK" : "FALHOU"} ${closed}`);
}
