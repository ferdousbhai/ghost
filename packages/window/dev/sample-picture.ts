// Sample pictures for the window's scripted QA: `<dir>/p1.png` … `p<count>.png`, each a different two-colour gradient,
// alternately wide and tall so the grid's cropping shows.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const [dir, count] = [process.argv[2] as string, Number(process.argv[3])];

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const frame = Buffer.alloc(body.length + 8);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(Bun.hash.crc32(body), body.length + 4);
  return frame;
}

for (let n = 1; n <= count; n += 1) {
  const [width, height] = n % 2 ? [320, 200] : [200, 320];
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      rows[at] = (n * 53 + (x * 160) / width) % 256;
      rows[at + 1] = (n * 97 + (y * 160) / height) % 256;
      rows[at + 2] = (n * 31 + 90) % 256;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  writeFileSync(`${dir}/p${n}.png`, png);
}
