// A janela do instalador (setup.rs): a pasta, o início com o Windows e o atalho, depois Instalar e
// Abrir. O NSIS roda em silêncio por baixo; a atualização não usa esta janela.
import { invoke } from "./common.js";

const $ = (id) => document.getElementById(id);
let info = null;
let dir = "";
let startup = true;
let desktop = false;
/** ready, installing, done, error */
let stage = "ready";
let error = "";

function setTog(el, on) {
  el.className = on ? "tog" : "tog off";
  el.setAttribute("aria-checked", String(on));
}

function render() {
  const busy = stage === "installing";
  const noNode = info && !info.node;
  $("close").classList.toggle("hidden", busy);
  $("dir").textContent = dir;
  $("dir").title = dir;
  setTog($("startup"), startup);
  setTog($("desktop"), desktop);
  $("opts").classList.toggle("hidden", stage === "installing" || stage === "done");
  $("progress").classList.toggle("hidden", !busy);
  $("mark").classList.toggle("busy", busy);
  $("install").classList.toggle("hidden", stage === "installing" || stage === "done");
  $("install").textContent = stage === "error" ? "Tentar de novo" : info?.installed ? `Atualizar para a ${info.version}` : "Instalar";
  $("install").disabled = !info || noNode;
  $("open").classList.toggle("hidden", stage !== "done");

  const line = $("line");
  line.className = "setupline";
  if (!info) line.textContent = "Carregando...";
  else if (stage === "installing") line.textContent = "Instalando. O card some do Discord por uns segundos.";
  else if (stage === "done") line.textContent = `Pronto: a ${info.version} está instalada. O ícone fica na bandeja, perto do relógio.`;
  else if (stage === "error") {
    line.textContent = error;
    line.classList.add("bad");
  } else if (noNode) {
    line.textContent = `Falta o Node.js ${info.nodeMin} ou mais novo. Instale pelo nodejs.org e abra este instalador de novo.`;
    line.classList.add("bad");
  } else if (info.installed) line.textContent = `Versão ${info.version} por cima da que já está nesta pasta. O config.json fica como está.`;
  else line.textContent = `Versão ${info.version}. O teu T3 Code e o Roblox no card do Discord, e ele se atualiza sozinho.`;
}

async function install() {
  stage = "installing";
  render();
  try {
    await invoke("setup_install", { dir, startup, desktop });
    stage = "done";
  } catch (e) {
    stage = "error";
    error = String(e);
  }
  render();
}

async function pick() {
  const picked = await invoke("setup_pick_folder");
  if (!picked) return;
  dir = picked;
  info = { ...info, installed: await invoke("setup_installed", { dir }) };
  render();
}

$("close").addEventListener("click", () => invoke("setup_close"));
$("pick").addEventListener("click", pick);
$("startup").addEventListener("click", () => {
  startup = !startup;
  render();
});
$("desktop").addEventListener("click", () => {
  desktop = !desktop;
  render();
});
$("install").addEventListener("click", install);
$("open").addEventListener("click", () =>
  invoke("setup_launch", { dir }).catch((e) => {
    stage = "error";
    error = String(e);
    render();
  }),
);

info = await invoke("setup_info");
dir = info.dir;
startup = info.startup;
render();
