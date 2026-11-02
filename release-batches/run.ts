import { Coordinator, type Operation } from "./coordinator.ts";
import { GitHub, Repository } from "./github.ts";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function run() {
  const repository = required("GITHUB_REPOSITORY");
  const legacy = process.env.RELEASE_LEGACY_BRANCH ?? "staging";
  const operation = process.env.RELEASE_OPERATION ?? "reconcile";
  if (!["reconcile", "bootstrap", "rollover"].includes(operation))
    throw new Error("Invalid release operation");
  const appId = Number(required("RELEASE_APP_ID"));
  if (!Number.isSafeInteger(appId) || appId <= 0)
    throw new Error("Invalid GitHub App ID");
  const coordinator = new Coordinator(
    new Repository(new GitHub(required("RELEASE_TOKEN")), repository, legacy),
    {
      repository,
      legacy,
      production: process.env.RELEASE_PRODUCTION_BRANCH ?? "main",
      timezone: process.env.RELEASE_TIMEZONE ?? "Europe/Zurich",
      now: new Date(),
    },
    appId,
  );
  const state = await coordinator.run(operation as Operation);
  const summary = `Active release batch: **${state.active}**${state.release ? ` · [release PR #${state.release}](https://github.com/${repository}/pull/${state.release})` : " · no unpublished changes"}\n`;
  if (process.env.GITHUB_STEP_SUMMARY)
    await Bun.write(process.env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
}

if (import.meta.main) await run();
