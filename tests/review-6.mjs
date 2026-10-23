// Bloco novo depois de uma pausa não vista. Uso: node tests/review-6.mjs [pasta do presence] (daemon parado)
import { DatabaseSync } from "node:sqlite";
import { spawnSync, spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.argv[2] || path.resolve(import.meta.dirname, "..");
const alivePid = Number(spawnSync("powershell", ["-NoProfile", "-c", "(Get-Process Discord)[0].Id"]).stdout.toString().trim());

const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-"));
fs.mkdirSync(path.join(home, "userdata"));
fs.writeFileSync(path.join(home, "userdata", "server-runtime.json"), JSON.stringify({ pid: alivePid }));
const dbPath = path.join(home, "userdata", "statev2.sqlite");
const db = new DatabaseSync(dbPath);
db.exec(`CREATE TABLE orchestration_v2_projection_runs (run_id, thread_id, status, requested_at, completed_at, payload_json);
  CREATE TABLE orchestration_v2_projection_threads (thread_id, project_id, title);
  CREATE TABLE projection_projects (project_id, title);
  CREATE TABLE orchestration_v2_projection_turn_items (thread_id, run_id, type, status, updated_at, ordinal);
  INSERT INTO orchestration_v2_projection_threads VALUES ('t1','p1','T');
  INSERT INTO projection_projects VALUES ('p1','Projeto X');`);
const aStart = new Date(Date.now() - 60_000).toISOString();
db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES ('A','t1','running',?,NULL,'{}')").run(aStart);

const cdir = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-cfg-"));
fs.copyFileSync(path.join(APP, "presence.mjs"), path.join(cdir, "presence.mjs"));
const cfg = JSON.parse(fs.readFileSync(path.join(APP, "config.json"), "utf8"));
Object.assign(cfg, { ociosoMinutos: 0.05, intervaloSegundos: 5, seguirUltimaMensagem: false });
fs.writeFileSync(path.join(cdir, "config.json"), JSON.stringify(cfg));

// Pipe falso: responde READY e ecoa SET_ACTIVITY, guardando cada envio com a hora.
const sends = [];
const pipe = "\\\\?\\pipe\\t3p-test-block";
const frame = (op, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(8);
  h.writeInt32LE(op, 0);
  h.writeInt32LE(b.length, 4);
  return Buffer.concat([h, b]);
};
const server = net.createServer((s) => {
  let buf = Buffer.alloc(0);
  s.on("error", () => {});
  s.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
      if (buf.length < 8 + len) break;
      const body = JSON.parse(buf.subarray(8, 8 + len));
      buf = buf.subarray(8 + len);
      if (op === 0) s.write(frame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
      else if (body.cmd === "SET_ACTIVITY") {
        sends.push({ at: Date.now(), start: body.args.activity?.timestamps?.start ?? null });
        s.write(frame(1, { cmd: "SET_ACTIVITY", nonce: body.nonce, data: { name: "fake" } }));
      }
    }
  });
});
await new Promise((r) => server.listen(pipe, r));
const child = spawn("node", ["--no-warnings", path.join(cdir, "presence.mjs")], {
  env: { ...process.env, T3CODE_HOME: home, T3P_IPC_PIPE: pipe, T3P_ROBLOX_RUNNING: "0" },
});

// Espera o primeiro envio (bloco A), e logo depois troca o banco entre dois ciclos:
// A termina agora, B começa 4 s depois (> 3 s de ociosoMinutos), sem ciclo no meio.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50 && !sends.length; i++) await wait(100);
const t0 = sends[0].at;
const bStart = t0 + 4000;
db.prepare("UPDATE orchestration_v2_projection_runs SET status='completed', completed_at=? WHERE run_id='A'").run(new Date(t0).toISOString());
db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES ('B','t1','running',?,NULL,'{}')").run(new Date(bStart).toISOString());
await wait(5200);
child.kill();
server.close();
db.close();

const first = sends[0].start, second = sends[1]?.start;
console.log(`envios: ${sends.map((s) => new Date(s.start).toISOString()).join(" , ")}`);
const ok = first === Date.parse(aStart) && second === bStart;
console.log(`bloco novo depois de pausa não vista: ${ok ? "OK" : "FALHOU"} (esperado A=${aStart}, B=${new Date(bStart).toISOString()})`);
