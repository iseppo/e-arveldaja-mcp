import { deflate as deflateCallback, inflate as inflateCallback } from "node:zlib";
import { promisify } from "node:util";

/**
 * Crops a rectangle out of a PNG that liteparse rendered. Only the form
 * liteparse emits is accepted: 8-bit RGBA (colour type 6), non-interlaced.
 * Every other form, a corrupt file or a cap breach throws; the caller turns
 * any throw into a hold. No PNG dependency: node:zlib plus an own CRC32
 * (`zlib.crc32` needs Node 20.15+, this package supports Node 18).
 */

const inflate = promisify(inflateCallback);
const deflate = promisify(deflateCallback);

export const PNG_CROP_MAX_INPUT_PIXELS = 40_000_000;
export const PNG_CROP_MAX_OUTPUT_BYTES = 64 * 1024;

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class PngCropError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngCropError";
  }
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BYTES_PER_PIXEL = 4;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) c = CRC_TABLE[(c ^ part[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface DecodedHeader {
  width: number;
  height: number;
  idat: Buffer;
}

function readChunks(png: Buffer): DecodedHeader {
  if (png.length < SIGNATURE.length || !png.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw new PngCropError("not a PNG");
  }
  let offset = SIGNATURE.length;
  let header: { width: number; height: number } | undefined;
  const idat: Buffer[] = [];
  let ended = false;
  while (offset < png.length && !ended) {
    if (offset + 12 > png.length) throw new PngCropError("truncated chunk");
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > 0x7fffffff || dataEnd + 4 > png.length) throw new PngCropError("truncated chunk");
    const data = png.subarray(dataStart, dataEnd);
    if (png.readUInt32BE(dataEnd) !== crc32(type, data)) throw new PngCropError("chunk CRC mismatch");
    const name = type.toString("latin1");
    if (header === undefined && name !== "IHDR") throw new PngCropError("IHDR is not first");
    if (name === "IHDR") {
      if (header !== undefined || length !== 13) throw new PngCropError("bad IHDR");
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const [bitDepth, colourType, compression, filter, interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (bitDepth !== 8 || colourType !== 6) throw new PngCropError("only 8-bit RGBA is supported");
      if (compression !== 0 || filter !== 0) throw new PngCropError("unknown compression or filter method");
      if (interlace !== 0) throw new PngCropError("interlaced PNG is not supported");
      if (width === 0 || height === 0) throw new PngCropError("empty image");
      if (width * height > PNG_CROP_MAX_INPUT_PIXELS) throw new PngCropError("image too large");
      header = { width, height };
    } else if (name === "IDAT") {
      idat.push(data);
    } else if (name === "IEND") {
      ended = true;
    }
    offset = dataEnd + 4;
  }
  if (header === undefined || !ended || idat.length === 0) throw new PngCropError("incomplete PNG");
  return { ...header, idat: Buffer.concat(idat) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverses the per-row filters of rows [0, rowCount) in place; returns the raw rows. */
function unfilter(data: Buffer, width: number, rowCount: number): Buffer[] {
  const stride = width * BYTES_PER_PIXEL;
  const rows: Buffer[] = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < rowCount; y++) {
    const start = y * (stride + 1);
    const filter = data[start];
    const row = Buffer.from(data.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const left = i >= BYTES_PER_PIXEL ? row[i - BYTES_PER_PIXEL]! : 0;
      const up = previous[i]!;
      const upLeft = i >= BYTES_PER_PIXEL ? previous[i - BYTES_PER_PIXEL]! : 0;
      switch (filter) {
        case 0: break;
        case 1: row[i] = (row[i]! + left) & 0xff; break;
        case 2: row[i] = (row[i]! + up) & 0xff; break;
        case 3: row[i] = (row[i]! + ((left + up) >> 1)) & 0xff; break;
        case 4: row[i] = (row[i]! + paeth(left, up, upLeft)) & 0xff; break;
        default: throw new PngCropError("unknown row filter");
      }
    }
    rows.push(row);
    previous = row;
  }
  return rows;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "latin1");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(typeBytes, data), 8 + data.length);
  return out;
}

/** Image size from the IHDR, without decoding (throws like `cropPng`). */
export function pngSize(png: Buffer): { width: number; height: number } {
  const { width, height } = readChunks(png);
  return { width, height };
}

/**
 * Returns a new RGBA PNG holding `rect` (pixels; clamped to the image, rounded
 * outward). Throws `PngCropError` on any unsupported or corrupt input, an
 * empty rectangle, or an output over PNG_CROP_MAX_OUTPUT_BYTES.
 */
export async function cropPng(png: Buffer, rect: PixelRect): Promise<Buffer> {
  const { width, height, idat } = readChunks(png);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  if (!Number.isFinite(x0 + y0 + x1 + y1) || x1 <= x0 || y1 <= y0) throw new PngCropError("empty crop");

  const stride = width * BYTES_PER_PIXEL;
  const expected = height * (stride + 1);
  let data: Buffer;
  try {
    data = await inflate(idat, { maxOutputLength: expected });
  } catch {
    throw new PngCropError("image data does not inflate");
  }
  if (data.length !== expected) throw new PngCropError("image data has the wrong length");

  const rows = unfilter(data, width, y1);
  const outWidth = x1 - x0;
  const outHeight = y1 - y0;
  const outStride = outWidth * BYTES_PER_PIXEL;
  const raw = Buffer.alloc(outHeight * (outStride + 1));
  for (let y = y0; y < y1; y++) {
    rows[y]!.copy(raw, (y - y0) * (outStride + 1) + 1, x0 * BYTES_PER_PIXEL, x1 * BYTES_PER_PIXEL);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(outWidth, 0);
  ihdr.writeUInt32BE(outHeight, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const out = Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  if (out.length > PNG_CROP_MAX_OUTPUT_BYTES) throw new PngCropError("crop too large");
  return out;
}
