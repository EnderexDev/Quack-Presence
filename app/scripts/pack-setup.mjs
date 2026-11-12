// Faz o Quack-Presence-Setup.exe: o Quack Presence.exe com o instalador NSIS anexado e um
// trailer (o tamanho do instalador, depois "QPSETUP1") que o setup.rs procura no fim do próprio
// arquivo. Mesmo esquema do Quackify (Quackify/scripts/pack-setup.mjs).
//
//   node scripts/pack-setup.mjs <Quack Presence.exe> <setup do nsis.exe> <saida.exe>
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAGIC = Buffer.from("QPSETUP1", "ascii");

export function packSetup(exe, installer, out) {
  const app = readFileSync(exe);
  const nsis = readFileSync(installer);
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(nsis.length));
  writeFileSync(out, Buffer.concat([app, nsis, length, MAGIC]));
}

// Rodado como script, não importado (release.mjs)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [exe, installer, out] = process.argv.slice(2);
  if (!out) {
    console.error("uso: node scripts/pack-setup.mjs <Quack Presence.exe> <setup do nsis.exe> <saida.exe>");
    process.exit(1);
  }
  packSetup(exe, installer, out);
  console.log(`pack-setup: ${out}`);
}
