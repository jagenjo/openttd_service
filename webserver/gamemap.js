// Mapa del juego como imagen: un píxel por casilla.
// El servidor de juego vuelca el mapa con `dump_map` (un byte por casilla):
//   0 terreno, 1 agua, 2 pueblo, 3 estación, 4 industria, 16 + n = casilla de la empresa n+1.
import fs from 'node:fs';
import { encodePng } from './png.js';

// Colores de empresa de OpenTTD (aproximados).
export const COMPANY_COLOURS = {
  'Dark Blue': [34, 54, 140], 'Pale Green': [136, 220, 120], Pink: [250, 130, 190], Yellow: [250, 220, 40],
  Red: [220, 30, 30], 'Light Blue': [90, 170, 240], Green: [30, 160, 50], 'Dark Green': [20, 90, 40],
  Blue: [40, 90, 220], Cream: [235, 215, 160], Mauve: [160, 100, 140], Purple: [130, 40, 170],
  Orange: [250, 140, 20], Brown: [130, 80, 30], Grey: [140, 140, 140], White: [250, 250, 250],
};
const BASE = [
  [58, 82, 52], // 0 terreno
  [28, 52, 92], // 1 agua
  [120, 120, 112], // 2 pueblo
  [255, 255, 255], // 3 estación
  [0, 0, 0], // 4 industria
];

export function renderMap(file, companies) {
  const buf = fs.readFileSync(file);
  const w = buf.readUInt32LE(0);
  const h = buf.readUInt32LE(4);
  const pixels = buf.subarray(8, 8 + w * h);
  if (pixels.length !== w * h) throw new Error('Volcado de mapa incompleto');
  const palette = Array.from({ length: 32 }, (_, i) => BASE[i] ?? [255, 0, 255]);
  for (const c of companies) palette[15 + c.id] = COMPANY_COLOURS[c.colour] ?? [255, 0, 255];
  return { width: w, height: h, png: encodePng(w, h, pixels, palette) };
}
