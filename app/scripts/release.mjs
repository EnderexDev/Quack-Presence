// Publica uma versão do Quack Presence, que as cópias instaladas pegam sozinhas (main.rs, setup.rs):
//
//   cd app && npm run release -- 1.0.1
//
// As notas são o [Unreleased] do CHANGELOG.md, que vira esta versão (changelog.mjs): sem nada lá o
// release para antes do build.
//
// De um checkout limpo (qualquer branch ou worktree, à frente da master): põe a versão no
// package.json, Cargo.toml e tauri.conf.json, gera o instalador assinado com a chave em
// ~/.tauri/quack-presence.key (TAURI_SIGNING_PRIVATE_KEY passa por cima), monta o
// Quack-Presence-Setup.exe (pack-setup.mjs), faz o commit e o push da versão na master e cria a
// release vX no GitHub com o Quack-Presence-Setup.exe (o que se baixa), o instalador NSIS e a
// assinatura dele (o que a atualização baixa) e o latest.json, que as cópias instaladas leem em
// releases/latest/download/latest.json.
// Sem essa chave nenhuma atualização sai assinada: as cópias instaladas só confiam na metade pública.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { packSetup } from "./pack-setup.mjs";
import { releaseNotes, stampRelease } from "./changelog.mjs";

const REPO = "EnderexDev/Quack-Presence";
const BRANCH = "master";
const app = join(import.meta.dirname, "..");
const root = join(app, "..");
const [version, ...extra] = process.argv.slice(2);

const fail = (why) => {
  console.error(`release: ${why}`);
  process.exit(1);
};
// npm é um .cmd no Windows e precisa do shell; git e gh não, e as notas mantêm os espaços.
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", shell: cmd === "npm", ...opts });
const read = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) fail("uso: npm run release -- 1.0.1 (as notas vêm do [Unreleased] do CHANGELOG.md)");
if (extra.length) fail("as notas agora vêm do CHANGELOG.md: escreva elas em \"## [Unreleased]\", faça o commit e rode só npm run release -- <versão>");
// A master do GitHub tem que ser o código do instalador: o push no fim só passa como fast-forward.
run("git", ["fetch", "origin", BRANCH]);
try {
  read("git", ["merge-base", "--is-ancestor", `origin/${BRANCH}`, "HEAD"]);
} catch {
  fail(`a ${BRANCH} do GitHub tem commits que este checkout não tem: traga eles antes`);
}
if (read("git", ["status", "--porcelain"])) fail("a árvore tem mudanças: faça o commit ou descarte antes");
const key = process.env.TAURI_SIGNING_PRIVATE_KEY ?? join(homedir(), ".tauri", "quack-presence.key");
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !existsSync(key)) fail(`sem a chave de assinatura em ${key}`);
const tag = `v${version}`;
if (read("git", ["tag", "--list", tag])) fail(`${tag} já existe`);

const edit = (file, change) => {
  const path = join(root, file);
  writeFileSync(path, change(readFileSync(path, "utf8")));
};
edit("app/package.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("app/src-tauri/tauri.conf.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("app/src-tauri/Cargo.toml", (s) => s.replace(/^version = "[^"]+"/m, `version = "${version}"`));

const VERSION_FILES = ["CHANGELOG.md", "app/package.json", "app/src-tauri/tauri.conf.json", "app/src-tauri/Cargo.toml", "app/src-tauri/Cargo.lock"];
/** Põe a versão velha de volta, para a próxima tentativa não parar em "a árvore tem mudanças" */
const undo = (why) => {
  run("git", ["checkout", "--", ...VERSION_FILES]);
  fail(`${why}; os arquivos de versão voltaram como estavam`);
};

// As notas: o [Unreleased] do CHANGELOG.md vira esta versão. Uma segunda tentativa acha a versão
// já carimbada e usa ela.
let notes;
try {
  const before = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const after = stampRelease(before, version, new Date().toISOString().slice(0, 10), REPO);
  writeFileSync(join(root, "CHANGELOG.md"), after);
  notes = releaseNotes(after, version).trim();
} catch (err) {
  undo(err.message);
}

try {
  run("npm", ["run", "app:build"], {
    cwd: app,
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" },
  });
} catch {
  undo("o build falhou");
}

const release = join(app, "src-tauri", "target", "release");
const bundle = join(release, "bundle", "nsis");
const built = join(bundle, `Quack Presence_${version}_x64-setup.exe`);
if (!existsSync(built) || !existsSync(`${built}.sig`)) undo(`o build não deixou o instalador com o .sig em ${bundle}`);
// O GitHub troca espaço por ponto no nome do arquivo: sem espaço, a url do latest.json bate.
const setup = `Quack-Presence_${version}_x64-setup.exe`;
const nsis = join(bundle, setup);
copyFileSync(built, nsis);
copyFileSync(`${built}.sig`, `${nsis}.sig`);
// O mesmo nome em toda versão: o README aponta para releases/latest/download/Quack-Presence-Setup.exe
const friendly = join(bundle, "Quack-Presence-Setup.exe");
packSetup(join(release, "quack-presence-tray.exe"), nsis, friendly);
const latest = join(bundle, "latest.json");
writeFileSync(
  latest,
  JSON.stringify(
    {
      version,
      notes,
      pub_date: new Date().toISOString(),
      platforms: {
        "windows-x86_64": {
          signature: readFileSync(`${nsis}.sig`, "utf8").trim(),
          url: `https://github.com/${REPO}/releases/download/${tag}/${setup}`,
        },
      },
    },
    null,
    2,
  ) + "\n",
);

run("git", ["add", ...VERSION_FILES]);
// Uma segunda tentativa depois de um push ou release que falhou acha a versão já no commit.
try {
  read("git", ["diff", "--cached", "--quiet"]);
} catch {
  try {
    run("git", ["commit", "-m", `Quack Presence ${version}`]);
  } catch {
    run("git", ["reset", "-q", "--", ...VERSION_FILES]);
    undo("o commit falhou");
  }
}
run("git", ["push", "origin", `HEAD:${BRANCH}`]);
// Nem rascunho nem pré-release: o releases/latest pula os dois, e as cópias não veriam a versão.
run("gh", ["release", "create", tag, friendly, nsis, `${nsis}.sig`, latest, "-R", REPO, "--target", read("git", ["rev-parse", "HEAD"]), "--title", `Quack Presence ${version}`, "--notes", notes || `Quack Presence ${version}`]);
console.log(`release: ${tag} publicada; as cópias instaladas pegam em até 6 horas, ou ao abrir`);
