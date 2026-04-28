#!/usr/bin/env node
/**
 * CLI for pi-para-daemon.
 *
 * Usage:
 *   pi-para-daemon start [--foreground]
 *   pi-para-daemon stop
 *   pi-para-daemon status
 *   pi-para-daemon process <session_file>
 *   pi-para-daemon process-recent [--hours N]
 *   pi-para-daemon retry-failed
 *   pi-para-daemon history [--scope NAME]
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync } from "node:fs";

import { Daemon } from "./daemon.js";
import { StateDB } from "./state.js";
import { RegistryWatcher } from "./watcher.js";

// -- Model setup -------------------------------------------------------------
// Use MiniMax via the same config as @picassio/qmd

async function createModel() {
  const { parse } = await import("yaml");
  const { readFileSync } = await import("node:fs");
  const { completeSimple } = await import("@mariozechner/pi-ai");

  const configPath = join(homedir(), ".config", "qmd", "index.yml");
  if (!existsSync(configPath)) {
    console.error("Error: No ~/.config/qmd/index.yml found. Configure providers first.");
    process.exit(1);
  }

  const cfg = parse(readFileSync(configPath, "utf-8"));
  const chat = cfg?.providers?.chat;
  if (!chat?.url || !chat?.key) {
    console.error("Error: No chat provider in ~/.config/qmd/index.yml");
    process.exit(1);
  }

  // Create a Model object compatible with pi-ai
  const model = {
    id: chat.model || "MiniMax-M2.7-highspeed",
    name: chat.model || "MiniMax-M2.7-highspeed",
    provider: "minimax",
    api: chat.api === "anthropic" ? "anthropic-messages" as const : "openai-completions" as const,
    baseUrl: chat.url,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 196000,
    maxTokens: 8192,
  };

  const getApiKey = async (_provider: string) => chat.key as string;

  return { model, getApiKey };
}

// -- CLI ---------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const wikiDir = join(homedir(), ".pi", "wiki");

  switch (command) {
    case "start": {
      const { model, getApiKey } = await createModel();
      const daemon = new Daemon({ wikiDir, model: model as any, getApiKey });

      process.on("SIGINT", async () => {
        await daemon.stop();
        process.exit(0);
      });
      process.on("SIGTERM", async () => {
        await daemon.stop();
        process.exit(0);
      });

      await daemon.start();

      // Keep process alive
      await new Promise(() => {});
      break;
    }

    case "stop": {
      const state = new StateDB(wikiDir);
      const pid = state.getState("daemon_pid");
      state.close();
      if (pid) {
        try {
          process.kill(parseInt(pid), "SIGTERM");
          console.log(`Sent SIGTERM to daemon (PID ${pid})`);
        } catch {
          console.log(`Daemon not running (PID ${pid} not found)`);
        }
      } else {
        console.log("No daemon PID recorded.");
      }
      break;
    }

    case "status": {
      const state = new StateDB(wikiDir);
      const pid = state.getState("daemon_pid");
      const startedAt = state.getState("daemon_started_at");
      const history = state.getHistory(undefined, 5);
      const failed = state.getFailed();
      state.close();

      let running = false;
      if (pid) {
        try {
          process.kill(parseInt(pid), 0);
          running = true;
        } catch {}
      }

      console.log(`Daemon: ${running ? `running (PID ${pid})` : "not running"}`);
      if (startedAt) console.log(`Started: ${startedAt}`);
      console.log(`Failed: ${failed.length}`);
      console.log(`\nRecent history:`);
      for (const h of history) {
        const status = h.error ? `ERROR: ${h.error.slice(0, 50)}` : `${h.pagesCreated.length} pages`;
        console.log(`  ${h.processedAt} | ${h.scope} | ${status}`);
      }
      break;
    }

    case "process": {
      const sessionFile = args[1];
      if (!sessionFile) {
        console.error("Usage: pi-para-daemon process <session_file>");
        process.exit(1);
      }
      const { model, getApiKey } = await createModel();
      const daemon = new Daemon({ wikiDir, model: model as any, getApiKey });
      await daemon.start();
      await daemon.processOne(sessionFile);
      await daemon.stop();
      break;
    }

    case "process-recent": {
      const hoursIdx = args.indexOf("--hours");
      const hours = hoursIdx >= 0 ? parseInt(args[hoursIdx + 1] ?? "24") : 24;
      const cutoff = Date.now() - hours * 60 * 60 * 1000;

      // Find recent sessions from registry
      const watcher = new RegistryWatcher(wikiDir, () => {});
      const entries = watcher.getAllEntries().filter((e) => {
        const ts = new Date(e.timestamp).getTime();
        return ts > cutoff;
      });

      const state = new StateDB(wikiDir);
      const unprocessed = entries.filter((e) => !state.isProcessed(e.sessionPath));
      state.close();

      if (unprocessed.length === 0) {
        console.log(`No unprocessed sessions in the last ${hours} hour(s).`);
        break;
      }

      console.log(`Found ${unprocessed.length} unprocessed session(s)`);
      const { model, getApiKey } = await createModel();
      const daemon = new Daemon({ wikiDir, model: model as any, getApiKey });
      await daemon.start();
      for (const entry of unprocessed) {
        await daemon.processOne(entry.sessionPath);
      }
      await daemon.stop();
      break;
    }

    case "retry-failed": {
      const { model, getApiKey } = await createModel();
      const daemon = new Daemon({ wikiDir, model: model as any, getApiKey });
      await daemon.start();
      await daemon.retryFailed();
      await daemon.stop();
      break;
    }

    case "history": {
      const scopeIdx = args.indexOf("--scope");
      const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : undefined;
      const state = new StateDB(wikiDir);
      const history = state.getHistory(scope, 20);
      state.close();

      if (history.length === 0) {
        console.log("No processing history.");
        break;
      }

      for (const h of history) {
        const status = h.error
          ? `ERROR: ${h.error.slice(0, 60)}`
          : h.pagesCreated.length > 0
            ? `${h.pagesCreated.length} page(s): ${h.pagesCreated.join(", ")}`
            : "skipped";
        console.log(`${h.processedAt} | ${h.scope} | ${status}`);
      }
      break;
    }

    default:
      console.log(`pi-para-daemon — background knowledge capture

Commands:
  start              Start the daemon (foreground)
  stop               Stop the running daemon
  status             Show daemon status and recent history
  process <file>     Process a single session file
  process-recent     Process unprocessed sessions (--hours N, default 24)
  retry-failed       Retry all failed sessions
  history            Show processing history (--scope NAME to filter)`);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
