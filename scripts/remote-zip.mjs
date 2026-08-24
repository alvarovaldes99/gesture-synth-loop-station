import { inflateRawSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [url, action = "list", patternText = ".*", outputDirectory = "."] = process.argv.slice(2);
if (!url) {
  console.error("Usage: node scripts/remote-zip.mjs <url> <list|extract> <regex> [output-directory]");
  process.exit(1);
}

const pattern = new RegExp(patternText, "i");

async function range(start, end) {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (response.status !== 206) throw new Error(`Server did not honor range ${start}-${end} (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

const head = await fetch(url, { method: "HEAD" });
if (!head.ok) throw new Error(`HEAD failed (${head.status})`);
const totalSize = Number(head.headers.get("content-length"));
if (!Number.isFinite(totalSize)) throw new Error("Archive has no Content-Length");

const tailStart = Math.max(0, totalSize - 1024 * 1024);
const tail = await range(tailStart, totalSize - 1);
let eocd = -1;
for (let index = tail.length - 22; index >= 0; index -= 1) {
  if (tail.readUInt32LE(index) === 0x06054b50) {
    eocd = index;
    break;
  }
}
if (eocd < 0) throw new Error("ZIP end-of-central-directory record not found");

const centralSize = tail.readUInt32LE(eocd + 12);
const centralOffset = tail.readUInt32LE(eocd + 16);
const central = centralOffset >= tailStart && centralOffset + centralSize <= totalSize
  ? tail.subarray(centralOffset - tailStart, centralOffset - tailStart + centralSize)
  : await range(centralOffset, centralOffset + centralSize - 1);

const entries = [];
for (let offset = 0; offset + 46 <= central.length && central.readUInt32LE(offset) === 0x02014b50;) {
  const flags = central.readUInt16LE(offset + 8);
  const method = central.readUInt16LE(offset + 10);
  const compressedSize = central.readUInt32LE(offset + 20);
  const uncompressedSize = central.readUInt32LE(offset + 24);
  const nameLength = central.readUInt16LE(offset + 28);
  const extraLength = central.readUInt16LE(offset + 30);
  const commentLength = central.readUInt16LE(offset + 32);
  const localOffset = central.readUInt32LE(offset + 42);
  const nameBytes = central.subarray(offset + 46, offset + 46 + nameLength);
  const name = nameBytes.toString(flags & 0x0800 ? "utf8" : "latin1").replaceAll("\\", "/");
  entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
  offset += 46 + nameLength + extraLength + commentLength;
}

const matches = entries.filter((entry) => pattern.test(entry.name) && !entry.name.endsWith("/"));
if (action === "list") {
  for (const entry of matches) console.log(`${entry.uncompressedSize}\t${entry.name}`);
  process.exit(0);
}
if (action !== "extract") throw new Error(`Unknown action: ${action}`);

await mkdir(outputDirectory, { recursive: true });
for (const entry of matches) {
  const localHeader = await range(entry.localOffset, entry.localOffset + 29);
  if (localHeader.readUInt32LE(0) !== 0x04034b50) throw new Error(`Bad local header for ${entry.name}`);
  const nameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = await range(dataStart, dataStart + entry.compressedSize - 1);
  const data = entry.method === 0 ? compressed : entry.method === 8 ? inflateRawSync(compressed) : null;
  if (!data) throw new Error(`Unsupported ZIP method ${entry.method} for ${entry.name}`);
  if (data.length !== entry.uncompressedSize) throw new Error(`Size mismatch for ${entry.name}`);
  const destination = path.join(outputDirectory, path.basename(entry.name));
  await writeFile(destination, data);
  console.log(`${data.length}\t${destination}`);
}

