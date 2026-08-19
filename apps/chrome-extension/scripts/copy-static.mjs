import { copyFile } from "node:fs/promises";

await Promise.all(
  [
    ["static/manifest.json", "dist/manifest.json"],
    ["static/popup.html", "dist/popup.html"],
    ["static/popup.css", "dist/popup.css"],
    ["dist/service-worker.global.js", "dist/service-worker.js"],
    ["dist/content.global.js", "dist/content.js"],
    ["dist/popup.global.js", "dist/popup.js"],
  ].map(([source, destination]) =>
    copyFile(
      new URL(`../${source}`, import.meta.url),
      new URL(`../${destination}`, import.meta.url),
    ),
  ),
);
