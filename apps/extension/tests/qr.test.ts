import { test } from "node:test";
import { strict as assert } from "node:assert";
import bs58 from "bs58";
import { addressMatrix } from "../src/lib/qr";

/**
 * Receive's QR codes, read back by an independent decoder written here from the QR specification (versions 1–6; numeric,
 * alphanumeric and byte segments). A clean matrix needs no error correction, so it reads the format, removes the mask, takes the
 * codewords in the standard zigzag order, undoes the block interleaving and parses the segments.
 */
const DATA_BLOCKS: Record<number, Record<string, number[]>> = { // data codewords per block, by version and error-correction level
  1: { L: [19], M: [16], Q: [13], H: [9] }, 2: { L: [34], M: [28], Q: [22], H: [16] },
  3: { L: [55], M: [44], Q: [17, 17], H: [13, 13] }, 4: { L: [80], M: [32, 32], Q: [24, 24], H: [9, 9, 9, 9] },
  5: { L: [108], M: [43, 43], Q: [15, 15, 16, 16], H: [11, 11, 12, 12] }, 6: { L: [68, 68], M: [27, 27, 27, 27], Q: [19, 19, 19, 19], H: [15, 15, 15, 15] },
};
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };
const ECC = ["M", "L", "H", "Q"]; // format bits 00, 01, 10, 11
const MASKS = [
  (x: number, y: number) => (x + y) % 2 === 0, (_: number, y: number) => y % 2 === 0, (x: number) => x % 3 === 0, (x: number, y: number) => (x + y) % 3 === 0,
  (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x: number, y: number) => (x * y) % 2 + (x * y) % 3 === 0,
  (x: number, y: number) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x: number, y: number) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];
const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

export function decodeQr(m: boolean[][]): string {
  const size = m.length, version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 6, `decoder covers versions 1–6, got ${size}×${size}`);
  // Function modules: finders with separators, timing, alignment, format areas and the dark module.
  const fn = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const mark = (x0: number, y0: number, w: number, h: number) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < size && y < size) fn[y]![x] = true; };
  mark(0, 0, 9, 9); mark(size - 8, 0, 8, 9); mark(0, size - 8, 9, 8);
  mark(6, 0, 1, size); mark(0, 6, size, 1);
  for (const cy of ALIGN[version]!) for (const cx of ALIGN[version]!) if (!((cx === 6 && cy === 6) || (cx === 6 && cy === ALIGN[version]!.at(-1)) || (cy === 6 && cx === ALIGN[version]!.at(-1)))) mark(cx - 2, cy - 2, 5, 5);
  // Format: 15 bits around the top-left finder (bit i at column 8, row i for i < 6, ...), XOR 0x5412.
  const at = (x: number, y: number) => m[y]![x] ? 1 : 0;
  let bits = 0;
  for (let i = 0; i < 6; i++) bits |= at(8, i) << i;
  bits |= at(8, 7) << 6; bits |= at(8, 8) << 7; bits |= at(7, 8) << 8;
  for (let i = 9; i < 15; i++) bits |= at(14 - i, 8) << i;
  const format = (bits ^ 0x5412) >> 10, ecc = ECC[format >> 3]!, mask = MASKS[format & 7]!;
  // Codewords: two-column zigzag from the bottom right, skipping the vertical timing column.
  const stream: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y]![x]) stream.push((m[y]![x] ? 1 : 0) ^ (mask(x, y) ? 1 : 0));
    }
  }
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= stream.length; i += 8) codewords.push(stream.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // Undo the interleaving of the data codewords (the error-correction codewords that follow aren't needed for a clean matrix).
  const blocks = DATA_BLOCKS[version]![ecc]!, data: number[][] = blocks.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(...blocks); i++) for (let b = 0; b < blocks.length; b++) if (i < blocks[b]!) data[b]!.push(codewords[k++]!);
  const bitsOut = data.flat().flatMap(c => [7, 6, 5, 4, 3, 2, 1, 0].map(s => (c >> s) & 1));
  let p = 0;
  const read = (n: number) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | (bitsOut[p++] ?? 0); return v; };
  let text = "";
  for (;;) {
    const mode = read(4);
    if (mode === 0) break;
    if (mode === 4) { const n = read(8); text += new TextDecoder().decode(Uint8Array.from({ length: n }, () => read(8))); }
    else if (mode === 2) { let n = read(9); for (; n >= 2; n -= 2) { const v = read(11); text += ALNUM[Math.floor(v / 45)]! + ALNUM[v % 45]!; } if (n) text += ALNUM[read(6)]!; }
    else if (mode === 1) { let n = read(10); for (; n >= 3; n -= 3) text += String(read(10)).padStart(3, "0"); if (n === 2) text += String(read(7)).padStart(2, "0"); else if (n === 1) text += String(read(4)); }
    else throw new Error(`segment mode ${mode} isn't one an address uses`);
  }
  return text;
}

test("Receive's QR codes decode back to exactly the address (EVM and Solana), read by an independent decoder", () => {
  const addresses = [
    "0x681242DAB7A89068536E684DC282cbDe5CCd4Ed3", "0x0000000000000000000000000000000000000001",
    bs58.encode(new Uint8Array(32).fill(7)), "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  ];
  for (const address of addresses) {
    const qr = addressMatrix(address);
    assert.equal(qr.data.length, qr.size, "no quiet zone in the matrix");
    assert.equal(decodeQr(qr.data), address);
  }
  // The decoder really reads the modules: one flipped data module (bottom right, the first codeword) changes what it reads.
  const flipped = addressMatrix(addresses[0]!).data.map(row => [...row]);
  const n = flipped.length;
  flipped[n - 1]![n - 1] = !flipped[n - 1]![n - 1];
  assert.throws(() => assert.equal(decodeQr(flipped), addresses[0]));
  // A one-character change gives a different code that decodes to the changed text: nothing is cached or normalized away.
  assert.equal(decodeQr(addressMatrix("0x681242DAB7A89068536E684DC282cbDe5CCd4Ed4").data), "0x681242DAB7A89068536E684DC282cbDe5CCd4Ed4");
});
