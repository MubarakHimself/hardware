import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const iconDirectory = join(repositoryRoot, "build", "icons");
const sourcePath = join(iconDirectory, "icon.svg");
const pngPath = join(iconDirectory, "icon.png");
const icoPath = join(iconDirectory, "icon.ico");
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

function createIco(images) {
  const headerSize = 6;
  const entrySize = 16;
  let imageOffset = headerSize + entrySize * images.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(entrySize);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(imageOffset, 12);
    imageOffset += png.length;
    return entry;
  });

  return Buffer.concat([
    header,
    ...entries,
    ...images.map(({ png }) => png),
  ]);
}

await mkdir(iconDirectory, { recursive: true });
const source = await readFile(sourcePath);
const linuxPng = await sharp(source)
  .resize(512, 512)
  .png({ compressionLevel: 9 })
  .toBuffer();
await writeFile(pngPath, linuxPng);

const icoImages = await Promise.all(
  icoSizes.map(async (size) => ({
    size,
    png: await sharp(source)
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toBuffer(),
  })),
);
await writeFile(icoPath, createIco(icoImages));

console.log(`Generated ${pngPath} and ${icoPath}.`);
