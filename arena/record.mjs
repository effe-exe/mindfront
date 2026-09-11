// Record a match: headless Chromium on the spectator page, WebM via Playwright,
// MP4 via ffmpeg. Runs until the brain process exits (or --minutes elapse).
//   node arena/record.mjs <gameID> [--minutes 25] [--out arena/records]
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const gameID = process.argv[2];
if (!gameID) throw new Error("usage: node arena/record.mjs <gameID> [--minutes N]");
const minutes = Number(process.argv[process.argv.indexOf("--minutes") + 1] || 25);
const outDir = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "arena/records";
const size = { width: 1280, height: 720 };

// Reuse whatever Chromium Playwright has cached (newest build) rather than
// downloading a build pinned to this package version; PW_CHROMIUM overrides.
const cache = path.join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
const cached = fs.existsSync(cache)
  ? fs.readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().at(-1)
  : undefined;
const executablePath =
  process.env.PW_CHROMIUM ??
  (cached && path.join(cache, cached, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"));
const browser = await chromium.launch({
  executablePath: executablePath && fs.existsSync(executablePath) ? executablePath : undefined,
  args: ["--use-gl=angle", "--use-angle=swiftshader"],
});
const context = await browser.newContext({
  viewport: size,
  recordVideo: { dir: path.join(outDir, "tmp"), size },
});
// Headless Chromium has no GPU: tell the client to accept a software WebGL context (initGL.ts).
await context.addInitScript(() => localStorage.setItem("mindfront.softwaregl", "1"));
const page = await context.newPage();
await page.goto(`http://localhost:9000/game/${gameID}?spectate`, { waitUntil: "load" });
console.log(`recording ${gameID} for up to ${minutes} min`);

// The brain writes <gameID>.json when the match ends; that is the stop signal.
const recordPath = path.join(outDir, `${gameID}.json`);
const deadline = Date.now() + minutes * 60_000;
while (Date.now() < deadline && !fs.existsSync(recordPath)) await new Promise((r) => setTimeout(r, 5000));
await new Promise((r) => setTimeout(r, 3000)); // let the win modal show

const video = page.video();
await context.close();
const webm = await video.path();
await browser.close();
// Keep the raw WebM next to the record until the MP4 is verified playable.
const keep = path.join(outDir, `${gameID}.webm`);
fs.renameSync(webm, keep);
const mp4 = path.join(outDir, `${gameID}.mp4`);
const tmp = mp4 + ".part.mp4";
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", keep, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", tmp]);
execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", tmp]);
fs.renameSync(tmp, mp4);
fs.rmSync(keep);
console.log(`saved ${mp4}`);
