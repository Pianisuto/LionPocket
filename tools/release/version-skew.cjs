// Execute the previous client implementation against the current real server.
const {
  mkdtempSync,
  symlinkSync,
  rmSync,
  mkdirSync,
  readdirSync,
} = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { execFileSync } = require("node:child_process");
const root = resolve(__dirname, "../..");
for (const base of [
  "8de0087cdbcdcc670ec2073ba3f4ea51932072b4",
  "cbd7067644c63e6c09802b208731b43d239c0031",
]) {
  const directory = mkdtempSync(
    join(tmpdir(), "lion-release-previous-client-"),
  );
  try {
    const archive = execFileSync(
      "git",
      ["archive", base, "packages/sync-local", "packages/sync-protocol"],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
    );
    execFileSync("tar", ["-x", "-C", directory], { input: archive });
    // Compile the previous client against its own previous protocol declarations and runtime.
    // A shared workspace link would accidentally typecheck old code against today's artifact union.
    mkdirSync(join(directory, "node_modules/@lionpocket"), { recursive: true });
    for (const name of readdirSync(join(root, "node_modules"))) {
      if (name !== "@lionpocket")
        symlinkSync(
          join(root, "node_modules", name),
          join(directory, "node_modules", name),
        );
    }
    for (const name of readdirSync(join(root, "node_modules/@lionpocket"))) {
      const target =
        name === "sync-protocol"
          ? join(directory, "packages/sync-protocol")
          : join(root, "node_modules/@lionpocket", name);
      symlinkSync(
        target,
        join(directory, "node_modules/@lionpocket", name),
        "dir",
      );
    }
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "-p",
        join(directory, "packages/sync-protocol/tsconfig.json"),
      ],
      { cwd: directory, stdio: "inherit" },
    );
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "-p",
        join(directory, "packages/sync-local/tsconfig.json"),
      ],
      { cwd: directory, stdio: "inherit" },
    );
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "src/beta.integration.test.ts",
      ],
      {
        cwd: join(root, "apps/sync-server"),
        stdio: "inherit",
        env: {
          ...process.env,
          LIONPOCKET_SYNC_INTEGRATION: "1",
          LIONPOCKET_PREVIOUS_CLIENT: join(
            directory,
            "packages/sync-local/dist/beta.js",
          ),
        },
      },
    );
    console.log(
      `PASS: previous engine/controller from ${base} interoperates with current PostgreSQL/Keycloak server.`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
