import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const pianoDirectory = path.join(projectRoot, "public", "samples", "acoustic-piano");
const archiveScript = path.join(scriptDirectory, "remote-zip.mjs");
const pianoPattern = String.raw`^Grand Piano, K/Sustains/GPiano_sus_(C2|C3|C4|C5|C6)_v(1|4)_rr1_Player\.flac$`;

const extraction = spawnSync(process.execPath, [
  archiveScript,
  "https://versilian-studios.com/Distro/VCSL_Keys.zip",
  "extract",
  pianoPattern,
  pianoDirectory,
], { stdio: "inherit" });

if (extraction.status !== 0) process.exit(extraction.status || 1);
await import(pathToFileURL(path.join(scriptDirectory, "fetch-samples.mjs")));

