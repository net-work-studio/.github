import { argumentsFor, command, gh } from "./cli.ts";
import { organizationRules, validateState } from "./model.ts";

interface Ruleset {
  id?: number;
  name: string;
  enforcement: string;
  conditions: {
    repository_id?: { repository_ids: number[] };
    ref_name: { include: string[]; exclude: string[] };
  };
  rules: unknown[];
  bypass_actors: unknown[];
  target: string;
}

function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => contains(actual[index], value))
    );
  if (expected && typeof expected === "object")
    return (
      !!actual &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) =>
        contains((actual as Record<string, unknown>)[key], value),
      )
    );
  return actual === expected;
}

function compatibleRules(actual: unknown[], expected: unknown[]) {
  return (
    actual.length === expected.length &&
    expected.every((rule) =>
      actual.some((candidate) => contains(candidate, rule)),
    )
  );
}

export function mergeAdoption(
  existing: Ruleset | null,
  desired: Ruleset,
  repoId: number,
): Ruleset {
  if (!existing) return desired;
  if (
    !existing.conditions.repository_id ||
    JSON.stringify(existing.bypass_actors) !==
      JSON.stringify(desired.bypass_actors)
  )
    throw new Error(
      "Existing opt-in rule uses a different App or repository selector; refusing to broaden it",
    );
  if (
    !compatibleRules(existing.rules, desired.rules) ||
    existing.target !== desired.target
  )
    throw new Error(
      "Existing opt-in rule has different protections; refusing to alter other adopters",
    );
  if (
    existing.enforcement !== "active" &&
    existing.conditions.repository_id.repository_ids.some((id) => id !== repoId)
  )
    throw new Error(
      "Cannot enable a disabled shared rule for other repositories implicitly",
    );
  return {
    ...desired,
    rules: existing.rules,
    enforcement: existing.enforcement,
    conditions: {
      ...desired.conditions,
      repository_id: {
        repository_ids: [
          ...new Set([
            ...existing.conditions.repository_id.repository_ids,
            repoId,
          ]),
        ],
      },
    },
  };
}

async function run() {
  const { repository, values } = argumentsFor(process.argv.slice(2));
  const [owner, name] = repository.split("/");
  const source = values.get("--source-ref") ?? "";
  if (!/^[0-9a-f]{40}$/.test(source))
    throw new Error(
      "Pass --source-ref with the reviewed shared workflow commit SHA",
    );
  const repo = await gh<{ id: number; default_branch: string }>(
    `repos/${repository}`,
  );
  const production = repo.default_branch;
  const shared = await gh<{ default_branch: string }>(`repos/${owner}/.github`);
  const comparison = await gh<{ status: string }>(
    `repos/${owner}/.github/compare/${source}...${shared.default_branch}`,
  );
  if (!["identical", "ahead"].includes(comparison.status)) {
    // Squash/rebase merges rewrite commit IDs. An exact reviewed PR head is
    // also a valid immutable pin once that PR merged into the default branch.
    const pulls = await gh<
      {
        merged_at: string | null;
        head: { sha: string };
        base: { ref: string };
      }[]
    >(`repos/${owner}/.github/commits/${source}/pulls?per_page=100`);
    if (
      !pulls.some(
        (pull) =>
          pull.merged_at &&
          pull.head.sha === source &&
          pull.base.ref === shared.default_branch,
      )
    )
      throw new Error(
        "Shared source must be reviewed and merged into the shared repository's default branch first",
      );
  }
  const caller = await gh<{ content: string }>(
    `repos/${repository}/contents/.github/workflows/release-batches.yml?ref=${production}`,
  );
  const callerText = Buffer.from(caller.content, "base64").toString();
  if (
    !callerText.includes(`release-batches.yml@${source}`) ||
    !callerText.includes(`source-ref: ${source}`)
  )
    throw new Error("Merge the pinned caller workflow before adoption");
  const appId = Number(
    await command(["gh", "variable", "get", "RELEASE_APP_ID", "--org", owner]),
  );
  if (!Number.isSafeInteger(appId) || appId <= 0)
    throw new Error("Register the release App first");

  const existing = await gh<{ id: number; name: string }[]>(
    `orgs/${owner}/rulesets?per_page=100`,
  );
  const desired = organizationRules([repo.id], appId, []);
  const plans: { path: string; rule: Ruleset; created: boolean }[] = [];
  for (const rule of desired) {
    const summary = existing.find((item) => item.name === rule.name);
    const current = summary
      ? await gh<Ruleset>(`orgs/${owner}/rulesets/${summary.id}`)
      : null;
    const merged = mergeAdoption(current, rule, repo.id);
    plans.push({
      path: `orgs/${owner}/rulesets${summary ? `/${summary.id}` : ""}`,
      rule: merged,
      created: !summary,
    });
  }
  process.stdout.write(
    `${JSON.stringify({ repository, appId, source, rulesets: plans.map(({ rule }) => rule) }, null, 2)}\n`,
  );
  if (!values.has("--apply")) {
    process.stdout.write(
      "Plan only. Pass --apply after reviewing the exact repository IDs and protections above.\n",
    );
    return;
  }

  // Preserve selected repositories when adopting another repo; never switch
  // an existing org secret/variable to all repositories or replace its key.
  for (const kind of [
    "secrets/RELEASE_APP_PRIVATE_KEY",
    "variables/RELEASE_APP_ID",
  ]) {
    await gh(`orgs/${owner}/actions/${kind}/repositories/${repo.id}`, "PUT");
  }
  const install = await gh<{
    installations: { app_id: number; repository_selection: string }[];
  }>(`orgs/${owner}/installations?per_page=100`);
  if (
    !install.installations.some(
      (item) =>
        item.app_id === appId && item.repository_selection === "selected",
    )
  )
    throw new Error(
      "Install the release App on explicitly selected repositories first",
    );

  const saved: { path: string; rule: Ruleset }[] = [];
  for (const plan of plans) {
    const productionRule = plan.rule.name.endsWith(": production");
    if (productionRule && !plan.created) {
      saved.push({ path: plan.path, rule: plan.rule });
      continue;
    }
    // New production protection stays disabled until bootstrap succeeds.
    const rule =
      plan.created && productionRule
        ? { ...plan.rule, enforcement: "disabled" }
        : { ...plan.rule, enforcement: "active" };
    const result = await gh<{ id: number }>(
      plan.path,
      plan.created ? "POST" : "PUT",
      rule,
    );
    saved.push({
      path: `orgs/${owner}/rulesets/${result.id}`,
      rule: plan.rule,
    });
  }

  const checks = (values.get("--checks") ?? "Project checks")
    .split(",")
    .map((value) => value.trim());
  if (checks.some((value) => !value))
    throw new Error("At least one named project check is required");
  const ci = await gh<{ id: number; name: string }[]>(
    `repos/${repository}/rulesets?includes_parents=false&per_page=100`,
  );
  const ciPlans: { path: string; rule: Record<string, unknown> }[] = [];
  for (const target of ["production", "batches"]) {
    const title = `Opt-in releases: ${target} checks`;
    const current = ci.find((rule) => rule.name === title);
    const rule = {
      name: title,
      target: "branch",
      enforcement: "active",
      bypass_actors:
        target === "batches"
          ? [
              {
                actor_type: "Integration",
                actor_id: appId,
                bypass_mode: "always",
              },
            ]
          : [],
      conditions: {
        ref_name: {
          include:
            target === "production"
              ? ["~DEFAULT_BRANCH"]
              : ["refs/heads/staging-*"],
          exclude: [],
        },
      },
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            do_not_enforce_on_create: true,
            required_status_checks: checks.map((context) => ({
              context,
              integration_id: 15368,
            })),
          },
        },
      ],
    };
    const result = await gh<{ id: number }>(
      `repos/${repository}/rulesets${current ? `/${current.id}` : ""}`,
      current ? "PUT" : "POST",
      current || target === "batches"
        ? rule
        : { ...rule, enforcement: "disabled" },
    );
    ciPlans.push({ path: `repos/${repository}/rulesets/${result.id}`, rule });
  }
  await command([
    "gh",
    "variable",
    "set",
    "RELEASE_BATCHES_ENABLED",
    "--repo",
    repository,
    "--body",
    "true",
  ]);
  const before = await gh<{ workflow_runs: { id: number }[] }>(
    `repos/${repository}/actions/workflows/release-batches.yml/runs?event=workflow_dispatch&per_page=10`,
  );
  const previousRuns = new Set(before.workflow_runs.map((run) => run.id));
  await command([
    "gh",
    "workflow",
    "run",
    "release-batches.yml",
    "--repo",
    repository,
    "--ref",
    production,
    "--field",
    "operation=bootstrap",
  ]);
  let runId: number | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    const runs = await gh<{
      workflow_runs: { id: number; created_at: string; event: string }[];
    }>(
      `repos/${repository}/actions/workflows/release-batches.yml/runs?event=workflow_dispatch&per_page=10`,
    );
    runId = runs.workflow_runs.find((run) => !previousRuns.has(run.id))?.id;
    if (runId) break;
    await Bun.sleep(2000);
  }
  if (!runId)
    throw new Error(
      "Bootstrap was queued; check Actions before rerunning adoption",
    );
  const monitor = Bun.spawn(
    [
      "gh",
      "run",
      "watch",
      String(runId),
      "--repo",
      repository,
      "--exit-status",
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  if ((await monitor.exited) !== 0)
    throw new Error(
      `Bootstrap needs attention: https://github.com/${repository}/actions/runs/${runId}`,
    );
  const stateFile = await gh<{ content: string }>(
    `repos/${repository}/contents/state.json?ref=release-batch-state`,
  );
  const state = validateState(
    JSON.parse(Buffer.from(stateFile.content, "base64").toString()),
  );
  if (state.transition || !state.active.startsWith("staging-"))
    throw new Error(
      "Bootstrap did not complete; production protection remains pending",
    );
  for (const plan of [...saved, ...ciPlans])
    await gh(plan.path, "PUT", { ...plan.rule, enforcement: "active" });
  process.stdout.write(
    `Enabled release batches for ${owner}/${name} only. Active batch: ${state.active}\n`,
  );
}

if (import.meta.main) await run();
