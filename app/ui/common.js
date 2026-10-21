// O que as duas janelas dividem: as chamadas ao app, o estado que ele manda e o montador de
// elementos do Quack (Quack/app/ui/common.js).
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
export { invoke, listen };

/** Montador de elementos: h("div", { class: "x", onclick }, "texto", filho) */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer;
export function toast(text, bad = false) {
  document.querySelector(".toast")?.remove();
  const node = h("div", { class: `toast chunk${bad ? " bad" : ""}` }, text);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), bad ? 5000 : 2200);
}

/** Uma chamada ao app que mostra o erro num toast em vez de sumir com ele */
export async function call(command, args) {
  try {
    return await invoke(command, args);
  } catch (error) {
    toast(String(error), true);
    throw error;
  }
}

/** Classe da bolinha para o nível do estado */
export const dotFor = (nivel) => ({ ok: "live", parado: "", erro: "bad" })[nivel] ?? "bad";

/** O estado atual e cada um que chegar depois */
export async function start(onView) {
  // Ouve antes de pedir: um erro no primeiro desenho não pode deixar a janela surda às próximas
  // e um evento que chegue enquanto o get_view responde é mais novo que a resposta dele.
  let evented = false;
  await listen("view", (event) => {
    evented = true;
    onView(event.payload ?? {});
  });
  const first = await invoke("get_view");
  if (!evented) onView(first ?? {});
}
