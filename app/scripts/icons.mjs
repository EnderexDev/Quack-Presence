// Gera os ícones do app e da bandeja a partir de app/assets/*.svg (o mesmo gerador do Quack).
//   RESVG=<caminho do @resvg/resvg-js> node app/scripts/icons.mjs
// O repo não tem node_modules: aponte RESVG para uma cópia instalada (a do Quack serve).
// As saídas ficam no git; rode de novo só depois de mudar um SVG.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { Resvg } = require(process.env.RESVG || "@resvg/resvg-js");

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");
const iconsDir = path.join(here, "..", "src-tauri", "icons");
const trayDir = path.join(here, "..", "src-tauri", "tray");
fs.mkdirSync(iconsDir, { recursive: true });
fs.mkdirSync(trayDir, { recursive: true });

const font = {
  fontFiles: [path.join(assets, "ArchivoBlack.ttf")],
  loadSystemFonts: false,
  defaultFontFamily: "Archivo Black",
};
const big = fs.readFileSync(path.join(assets, "icon.svg"), "utf8");
const small = fs.readFileSync(path.join(assets, "icon-small.svg"), "utf8");

// Em 24 px ou menos a sombra vira borrão: esses tamanhos usam o corte de contorno grosso.
const render = (size, svg = size <= 24 ? small : big) =>
  new Resvg(svg, { font, fitTo: { mode: "width", value: size } }).render().asPng();

for (const [name, size] of [["32x32.png", 32], ["128x128.png", 128], ["128x128@2x.png", 256], ["icon.png", 512]]) {
  fs.writeFileSync(path.join(iconsDir, name), render(size));
}

// Um .ico é um diretório de PNGs: o Windows escolhe o tamanho.
function ico(sizes) {
  const images = sizes.map((size) => ({ size, png: render(size) }));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}
fs.writeFileSync(path.join(iconsDir, "icon.ico"), ico([16, 20, 24, 32, 48, 64, 256]));

// Bandeja: o corte pequeno com a bolinha de estado no canto. Verde = card no Discord,
// cinza = sem card (ocioso ou T3 fechado), vermelho = Discord fora ou programa sem resposta.
const dots = { ok: "#4ade80", parado: "#9a8f80", erro: "#f23f43" };
for (const [state, color] of Object.entries(dots)) {
  const svg = small.replace(
    "</svg>",
    `<circle cx="50" cy="50" r="12" fill="${color}" stroke="#0a0806" stroke-width="5"/></svg>`,
  );
  fs.writeFileSync(path.join(trayDir, `${state}.png`), render(32, svg));
}
console.log(`ícones em ${iconsDir} e ${trayDir}`);
