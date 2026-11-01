// Gera os ícones do app e da bandeja a partir de app/assets/*.svg (o mesmo gerador do Quack).
//   RESVG=<caminho do @resvg/resvg-js> node app/scripts/icons.mjs
// O repo não tem node_modules: aponte RESVG para uma cópia instalada (a do Quack serve).
// As saídas ficam no git; rode de novo só depois de mudar um SVG.
// Os SVGs são exportados do Figma "Quack - Logo", página "◉ Quack Presence": icon.svg do frame
// presence-icon, tray-*.svg dos frames presence-tray-* (a mesma logo com a bolinha na cor do estado).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// RESVG relativo vale a partir da pasta atual, não desta.
const { Resvg } = require(process.env.RESVG ? path.resolve(process.env.RESVG) : "@resvg/resvg-js");

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");
const iconsDir = path.join(here, "..", "src-tauri", "icons");
const trayDir = path.join(here, "..", "src-tauri", "tray");
fs.mkdirSync(iconsDir, { recursive: true });
fs.mkdirSync(trayDir, { recursive: true });

const read = (name) => fs.readFileSync(path.join(assets, name), "utf8");
const render = (svg, size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
const icon = read("icon.svg");

for (const [name, size] of [["32x32.png", 32], ["128x128.png", 128], ["128x128@2x.png", 256], ["icon.png", 512]]) {
  fs.writeFileSync(path.join(iconsDir, name), render(icon, size));
}

// Um .ico é um diretório de PNGs: o Windows escolhe o tamanho.
function ico(sizes) {
  const images = sizes.map((size) => ({ size, png: render(icon, size) }));
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

// Bandeja: a bolinha da logo na cor do estado. Verde = card no Discord,
// cinza = sem card (ocioso ou T3 fechado), vermelho = Discord fora ou programa sem resposta.
for (const state of ["ok", "parado", "erro"]) {
  fs.writeFileSync(path.join(trayDir, `${state}.png`), render(read(`tray-${state}.svg`), 32));
}
console.log(`ícones em ${iconsDir} e ${trayDir}`);
