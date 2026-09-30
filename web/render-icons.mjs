import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const source = fileURLToPath(new URL("./icons/icon.svg", import.meta.url));
const outputs = [
  [192, "./public/icons/icon-192.png"],
  [512, "./public/icons/icon-512.png"],
  [180, "./public/icons/apple-touch-icon.png"],
];

for (const [size, relativePath] of outputs) {
  const output = fileURLToPath(new URL(relativePath, import.meta.url));
  await mkdir(dirname(output), { recursive: true });
  await sharp(source).resize(size, size, { fit: "cover" }).png({ compressionLevel: 9 }).toFile(output);
}
