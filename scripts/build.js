"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) {
    console.error(`Could not run ${command}: ${result.error.message}`);
    console.error("Install Extism JS compiler (extism-js) and Binaryen; see README.md.");
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
run(process.env.EXTISM_JS || "extism-js", [
  "src/plugin.js", "-i", "src/plugin.d.ts", "-o", "dist/plugin.wasm",
], { env: { ...process.env, XDG_CACHE_HOME: path.join(dist, ".cache") } });
fs.copyFileSync(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
fs.copyFileSync(path.join(root, "LICENSE"), path.join(dist, "LICENSE"));
const archive = path.join(dist, "automatic-ratings.ndp");
if (fs.existsSync(archive)) fs.unlinkSync(archive);
run("zip", ["-q", "-X", "automatic-ratings.ndp", "manifest.json", "plugin.wasm", "LICENSE"], { cwd: dist });
console.log(`Built ${archive}`);
