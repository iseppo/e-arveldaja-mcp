import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { crc32, cropPng, pngSize, PngCropError, PNG_CROP_MAX_OUTPUT_BYTES } from "./png-crop.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "latin1");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(typeBytes, data), 8 + data.length);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Independent encoder: row y uses filters[y % filters.length]. */
function encode(
  width: number,
  height: number,
  pixels: Buffer,
  filters: number[],
  ihdr: { bitDepth?: number; colourType?: number; interlace?: number } = {},
  idatSplit = 1,
): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length]!;
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const cur = pixels[y * stride + i]!;
      const left = i >= 4 ? pixels[y * stride + i - 4]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const upLeft = y > 0 && i >= 4 ? pixels[(y - 1) * stride + i - 4]! : 0;
      const pred = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]!;
      raw[y * (stride + 1) + 1 + i] = (cur - pred) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = ihdr.bitDepth ?? 8;
  header[9] = ihdr.colourType ?? 6;
  header[12] = ihdr.interlace ?? 0;
  const data = deflateSync(raw);
  const parts = [SIGNATURE, chunk("IHDR", header)];
  const size = Math.ceil(data.length / idatSplit);
  for (let at = 0; at < data.length; at += size) parts.push(chunk("IDAT", data.subarray(at, at + size)));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function decodeFilterZero(png: Buffer): { width: number; height: number; pixels: Buffer } {
  const { width, height } = pngSize(png);
  let offset = 8;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    if (png.toString("latin1", offset + 4, offset + 8) === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0);
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, pixels };
}

function noise(width: number, height: number, seed = 7): Buffer {
  const out = Buffer.alloc(width * height * 4);
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s >> 16;
  }
  return out;
}

function region(pixels: Buffer, width: number, x: number, y: number, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) pixels.copy(out, row * w * 4, ((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4);
  return out;
}

describe("cropPng", () => {
  const W = 23, H = 17;
  const pixels = noise(W, H);

  it.each([[[0]], [[1]], [[2]], [[3]], [[4]], [[0, 1, 2, 3, 4]], [[4, 3, 2, 1, 0]]])(
    "round-trips a crop through row filters %j",
    async (filters) => {
      const png = encode(W, H, pixels, filters, {}, 3);
      const crop = decodeFilterZero(await cropPng(png, { x: 5, y: 4, width: 11, height: 9 }));
      expect([crop.width, crop.height]).toEqual([11, 9]);
      expect(crop.pixels.equals(region(pixels, W, 5, 4, 11, 9))).toBe(true);
    },
  );

  it.each([0, 1, 2, 3, 4])("round-trips low-range pixels (Paeth/average ties) through filter %i", async (filter) => {
    const lowRange = Buffer.from(noise(W, H, 11).map(byte => byte & 3));
    const png = encode(W, H, lowRange, [filter]);
    const crop = decodeFilterZero(await cropPng(png, { x: 1, y: 1, width: W - 2, height: H - 2 }));
    expect(crop.pixels.equals(region(lowRange, W, 1, 1, W - 2, H - 2))).toBe(true);
  });

  it("clamps to the image and rounds fractional edges outward", async () => {
    const png = encode(W, H, pixels, [4]);
    const crop = decodeFilterZero(await cropPng(png, { x: -3.5, y: 10.2, width: 50, height: 4.1 }));
    expect([crop.width, crop.height]).toEqual([W, 5]);
    expect(crop.pixels.equals(region(pixels, W, 0, 10, W, 5))).toBe(true);
  });

  it("refuses an empty crop", async () => {
    const png = encode(W, H, pixels, [0]);
    await expect(cropPng(png, { x: 30, y: 0, width: 5, height: 5 })).rejects.toThrow(PngCropError);
    await expect(cropPng(png, { x: 0, y: 0, width: 0, height: 5 })).rejects.toThrow("empty crop");
    await expect(cropPng(png, { x: Number.NaN, y: 0, width: 5, height: 5 })).rejects.toThrow("empty crop");
  });

  it.each([
    ["8-bit RGB", { colourType: 2 }, "only 8-bit RGBA"],
    ["16-bit RGBA", { bitDepth: 16 }, "only 8-bit RGBA"],
    ["interlaced", { interlace: 1 }, "interlaced"],
  ])("refuses %s", async (_name, ihdr, message) => {
    await expect(cropPng(encode(4, 4, noise(4, 4), [0], ihdr), { x: 0, y: 0, width: 2, height: 2 })).rejects.toThrow(message);
  });

  it("refuses a non-PNG, a bad CRC, a truncated file and an unknown row filter", async () => {
    const rect = { x: 0, y: 0, width: 2, height: 2 };
    await expect(cropPng(Buffer.from("not a png at all"), rect)).rejects.toThrow("not a PNG");
    const png = encode(4, 4, noise(4, 4), [0]);
    const badCrc = Buffer.from(png);
    badCrc[30] ^= 0xff;
    await expect(cropPng(badCrc, rect)).rejects.toThrow("CRC");
    await expect(cropPng(png.subarray(0, png.length - 6), rect)).rejects.toThrow(PngCropError);
    const badFilter = encode(4, 4, noise(4, 4), [5 as number]);
    await expect(cropPng(badFilter, rect)).rejects.toThrow("unknown row filter");
  });

  it("refuses image data of the wrong length", async () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(4, 0);
    header.writeUInt32BE(4, 4);
    header[8] = 8;
    header[9] = 6;
    const short = Buffer.concat([
      SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(10))), chunk("IEND", Buffer.alloc(0)),
    ]);
    await expect(cropPng(short, { x: 0, y: 0, width: 2, height: 2 })).rejects.toThrow("wrong length");
    const long = Buffer.concat([
      SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(200))), chunk("IEND", Buffer.alloc(0)),
    ]);
    await expect(cropPng(long, { x: 0, y: 0, width: 2, height: 2 })).rejects.toThrow(PngCropError);
  });

  it("refuses an input over 40 megapixels without inflating it", async () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(8000, 0);
    header.writeUInt32BE(5001, 4);
    header[8] = 8;
    header[9] = 6;
    const huge = Buffer.concat([
      SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(1))), chunk("IEND", Buffer.alloc(0)),
    ]);
    await expect(cropPng(huge, { x: 0, y: 0, width: 2, height: 2 })).rejects.toThrow("image too large");
  });

  it("refuses an output over the 64 KB cap", async () => {
    const png = encode(200, 200, randomBytes(200 * 200 * 4), [0]);
    expect(PNG_CROP_MAX_OUTPUT_BYTES).toBe(65_536);
    await expect(cropPng(png, { x: 0, y: 0, width: 200, height: 200 })).rejects.toThrow("crop too large");
    await expect(cropPng(png, { x: 0, y: 0, width: 50, height: 50 })).resolves.toBeInstanceOf(Buffer);
  });
});
