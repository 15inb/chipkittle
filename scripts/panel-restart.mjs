import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(process.env.PANEL_UPDATE_ROOT || process.cwd());
const dataDir = path.join(root, "data");
const statusPath = path.join(dataDir, "update-status.json");
const pm2Name = process.env.PM2_PROCESS_NAME || "chipkittle";

async function writeStatus(status, extra = {}) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    statusPath,
    `${JSON.stringify(
      {
        status,
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        ...extra
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: process.platform === "win32",
      env: process.env
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const trimmedOutput = output.trim();
      if (code === 0) {
        resolve(trimmedOutput);
        return;
      }

      const error = new Error(`${command} ${args.join(" ")} exited with code ${code}`);
      error.output = trimmedOutput;
      reject(error);
    });
  });
}

try {
  await writeStatus("restarting", {
    log: `$ pm2 restart ${pm2Name}\nRestart command is being handed to PM2.`
  });
  const output = await run("pm2", ["restart", pm2Name]);
  await writeStatus("restarted", {
    log: `$ pm2 restart ${pm2Name}\n${output}`
  });
} catch (error) {
  await writeStatus("failed", {
    error: error.message,
    log: error.output || error.stack || error.message
  });
  process.exitCode = 1;
}
