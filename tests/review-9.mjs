// Esconder e deixar privado um projeto pela janela: o patchText que grava o config.json e o card
// com o projeto escondido ou privado. Uso: node tests/review-9.mjs [pasta do presence]
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP = process.argv[2] || path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(APP, "presence.mjs");
let fails = 0;
const check = (name, ok, extra = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "OK  " : "FALHA"} ${name}${extra ? " | " + extra : ""}`);
};

process.env.T3P_IMPORT = "1";
const { patchText } = await import(pathToFileURL(SCRIPT).href);

const base = `{
  "ativo": true,

  "projetos": {
    "A": { "nome": "Apelido" },
    "B": { "nome": "Bê", "ignorar": false }
  },
  "fim": 1
}
`;

{
  const out = patchText(base, { projetos: { B: { ignorar: true } } });
  check("troca um valor que existe só nele", out === base.replace('"ignorar": false', '"ignorar": true'), out);
}
{
  // A não tem ignorar, B tem: o de B não pode mudar
  const out = patchText(base, { projetos: { A: { ignorar: true } } });
  check("insere a chave no objeto certo", out === base.replace('"nome": "Apelido" }', '"nome": "Apelido", "ignorar": true }'), out);
}
{
  const out = patchText(base, { projetos: { C: { ignorar: true, privado: false } } });
  const want = base.replace('"ignorar": false }', '"ignorar": false },\n    "C": { "ignorar": true, "privado": false }');
  check("insere um projeto novo na linha dele", out === want, out);
}
{
  const out = patchText(`{ "ativo": true }`, { projetos: { 'X "y"': { privado: true } } });
  check("cria o objeto que falta", out === `{ "ativo": true, "projetos": { "X \\"y\\"": { "privado": true } } }`, out);
}
{
  const out = patchText(`{ "projetos": {} }`, { projetos: { A: { privado: true } } });
  check("insere num objeto vazio", out === `{ "projetos": { "A": { "privado": true } } }`, out);
}
{
  const out = patchText(base, { ativo: false, projetos: { A: { privado: true }, B: { ignorar: true } } });
  const want = base
    .replace('"ativo": true', '"ativo": false')
    .replace('"nome": "Apelido" }', '"nome": "Apelido", "privado": true }')
    .replace('"ignorar": false', '"ignorar": true');
  check("várias chaves de uma vez, o resto do texto igual", out === want, out);
}
{
  // Chave com "{" no texto de um valor antes dela: o leitor pula as strings
  const text = `{ "x": "a { b } \\" c", "projetos": { "A": {} } }`;
  const out = patchText(text, { projetos: { A: { ignorar: true } } });
  check("strings com chaves e aspas não confundem", out === `{ "x": "a { b } \\" c", "projetos": { "A": { "ignorar": true } } }`, out);
}

// Card: banco falso com dois projetos, o mais recente escondido ou privado.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-proj-"));
const cdir = fs.mkdtempSync(path.join(os.tmpdir(), "t3p-proj-app-"));
process.on("exit", () => {
  for (const d of [home, cdir]) fs.rmSync(d, { recursive: true, force: true });
});
fs.mkdirSync(path.join(home, "userdata"));
fs.writeFileSync(path.join(home, "userdata", "server-runtime.json"), JSON.stringify({ pid: process.pid }));
const db = new DatabaseSync(path.join(home, "userdata", "statev2.sqlite"));
const iso = (minAgo) => new Date(Date.now() - minAgo * 60_000).toISOString();
db.exec(`CREATE TABLE orchestration_v2_projection_runs (run_id, thread_id, status, requested_at, completed_at, payload_json);
  CREATE TABLE orchestration_v2_projection_threads (thread_id, project_id, title);
  CREATE TABLE projection_projects (project_id, title, deleted_at);
  CREATE TABLE orchestration_v2_projection_turn_items (thread_id, run_id, type, status, updated_at, ordinal);
  INSERT INTO orchestration_v2_projection_threads VALUES ('t1','p1','Conversa visível'), ('t2','p2','Conversa secreta');
  INSERT INTO projection_projects VALUES ('p1','Visível',NULL), ('p2','Secreto',NULL);`);
db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?,?,'{}')").run("R1", "t1", "completed", iso(6), iso(5));
db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?,?,'{}')").run("R2", "t2", "running", iso(1), null);
db.close();

fs.copyFileSync(SCRIPT, path.join(cdir, "presence.mjs"));
const cfg = JSON.parse(fs.readFileSync(path.join(APP, "config.json"), "utf8"));
cfg.jogos = [];
cfg.modoAtivo = "completo";
cfg.mostrar = { ...cfg.mostrar, thread: true };
cfg.imagem = { ...cfg.imagem, textoGrande: "{projeto}" };
const card = (projetos) => {
  fs.writeFileSync(path.join(cdir, "config.json"), JSON.stringify({ ...cfg, projetos }));
  const out = spawnSync("node", ["--no-warnings", path.join(cdir, "presence.mjs"), "--dry"], {
    env: { ...process.env, T3P_IMPORT: "", T3CODE_HOME: home, T3P_NO_TRAY: "1" },
  });
  const json = out.stdout.toString().split("\n").filter((l) => !l.startsWith("[")).join("\n");
  try {
    return JSON.parse(json) ?? {};
  } catch {
    return { erro: out.stdout.toString() + out.stderr.toString() };
  }
};
const text = (a) => JSON.stringify(a);

{
  const a = card({});
  check("sem marcação, mostra o projeto que roda", text(a).includes("Secreto") && text(a).includes("Conversa secreta"), text(a));
}
{
  const a = card({ Secreto: { ignorar: true } });
  check("escondido some do card, fica o outro", !text(a).includes("Secret") && text(a).includes("Visível"), text(a));
}
{
  const a = card({ Secreto: { privado: true, imagem: "https://img.test/secreto.png" } });
  const t = text(a);
  check("privado troca o nome e tira a conversa", !t.includes("Secreto") && !t.includes("Conversa secreta") && t.includes(cfg.textoProjetoPrivado), t);
  check("privado não usa a imagem do projeto", !t.includes("secreto.png"), t);
}

if (fails) {
  console.log(`${fails} falha(s)`);
  process.exit(1);
}
console.log("tudo certo");
