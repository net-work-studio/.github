import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator, type Port } from "./coordinator.ts";
import type { Options, Pull, State } from "./model.ts";

const options: Options = {
  repository: "example/site",
  production: "main",
  legacy: "staging",
  timezone: "Europe/Zurich",
  now: new Date("2026-11-04T10:00:00Z"),
};

class Memory implements Port {
  state: State | null = null;
  refs = new Map([
    ["main", "main-sha"],
    ["staging", "staging-sha"],
    ["feature/a", "feature-sha"],
  ]);
  trees = new Map([
    ["main-sha", "published"],
    ["staging-sha", "pending"],
    ["feature-sha", "feature"],
  ]);
  frozenBranches = new Set<string>();
  pr = new Map<number, Pull>();
  statuses = new Map<string, string | null>();
  failRetarget = false;
  conflict = false;
  constructor() {
    this.pr.set(1, this.makePull(1, "feature/a", "staging"));
  }
  makePull(number: number, head: string, base: string): Pull {
    return {
      number,
      head,
      base,
      sha: this.refs.get(head) ?? "",
      repository: options.repository,
      draft: false,
      merged: false,
      open: true,
    };
  }
  async branch(name: string) {
    return this.refs.get(name) ?? null;
  }
  async createBranch(name: string, sha: string) {
    this.refs.set(name, sha);
  }
  async load() {
    return structuredClone(this.state);
  }
  async save(state: State) {
    this.state = structuredClone(state);
  }
  async merge(base: string, head: string) {
    if (this.conflict && head === "staging-sha") return false;
    const sha = this.refs.get(head) ?? head;
    if (this.trees.get(sha) !== "published") {
      this.refs.set(base, sha);
      for (const pull of this.pr.values())
        if (pull.head === base && pull.open) pull.sha = sha;
    }
    return true;
  }
  async sameTree(left: string, right: string) {
    return this.trees.get(left) === this.trees.get(right);
  }
  async pulls() {
    return [...this.pr.values()]
      .filter((pull) => pull.open)
      .map((pull) => ({ ...pull }));
  }
  async pull(number: number) {
    const pull = this.pr.get(number);
    if (!pull) throw new Error("Missing PR");
    return { ...pull };
  }
  async updatePull(number: number, values: { base?: string; state?: string }) {
    if (values.base && this.failRetarget)
      throw new Error("Injected API failure");
    const pull = this.pr.get(number);
    if (!pull) throw new Error("Missing PR");
    if (values.base) pull.base = values.base;
    if (values.state === "closed") pull.open = false;
  }
  async createRelease(head: string, base: string) {
    const pull = {
      ...this.makePull(this.pr.size + 1, head, base),
      draft: true,
    };
    this.pr.set(pull.number, pull);
    return { ...pull };
  }
  async frozen(branch: string) {
    return this.frozenBranches.has(branch);
  }
  async freeze(branch: string) {
    this.frozenBranches.add(branch);
  }
  async unfreeze(branch: string) {
    this.frozenBranches.delete(branch);
  }
  async status(sha: string, error: string | null) {
    this.statuses.set(sha, error);
  }
}

test("bootstrap preserves staging, retargets feature PRs and opens a draft release", async () => {
  const repo = new Memory();
  const state = await new Coordinator(repo, options, 999).run("bootstrap");
  expect(state.active).toBe("staging-2026-W45-1");
  expect(repo.refs.get(state.active)).toBe("staging-sha");
  expect(repo.pr.get(1)?.base).toBe(state.active);
  expect(repo.frozenBranches.has("staging")).toBe(true);
  expect(repo.frozenBranches.has(state.active)).toBe(false);
  expect(repo.pr.get(state.release ?? 0)?.draft).toBe(true);
});

test("freeze on ready, release once, and retry without creating duplicate successors", async () => {
  const repo = new Memory();
  const coordinator = new Coordinator(repo, options, 999);
  let state = await coordinator.run("bootstrap");
  const release = repo.pr.get(state.release ?? 0);
  if (!release) throw new Error("No release");
  release.draft = false;
  state = await coordinator.run("reconcile");
  expect(repo.frozenBranches.has(state.active)).toBe(true);
  expect(state.releaseSha).toBe("staging-sha");
  // GitHub squash produces a different SHA with the same published files.
  repo.refs.set("main", "squash-sha");
  repo.trees.set("squash-sha", "pending");
  repo.trees.set("main-sha", "published");
  release.merged = true;
  release.open = false;
  state = await coordinator.run("reconcile");
  expect(state.active).toBe("staging-2026-W45-2");
  expect(repo.refs.get(state.active)).toBe("squash-sha");
  expect(state.release).toBeUndefined();
  expect((await coordinator.run("reconcile")).active).toBe(state.active);
  expect(repo.frozenBranches.has("staging-2026-W45-1")).toBe(true);
});

test("failed PR transfer leaves journal and both branches frozen; retry completes", async () => {
  const repo = new Memory();
  repo.failRetarget = true;
  const coordinator = new Coordinator(repo, options, 999);
  await expect(coordinator.run("bootstrap")).rejects.toThrow(
    "Injected API failure",
  );
  expect(repo.state?.transition?.to).toBe("staging-2026-W45-1");
  expect(repo.frozenBranches.has("staging")).toBe(true);
  expect(repo.frozenBranches.has("staging-2026-W45-1")).toBe(true);
  repo.failRetarget = false;
  expect((await coordinator.run("bootstrap")).active).toBe(
    "staging-2026-W45-1",
  );
});

test("carryover conflict leaves original active and unfreezes it without losing edits", async () => {
  const repo = new Memory();
  repo.conflict = true;
  const coordinator = new Coordinator(repo, options, 999);
  await expect(coordinator.run("bootstrap")).rejects.toThrow(
    "Carryover conflicts",
  );
  expect(repo.state?.active).toBe("staging");
  expect(repo.refs.get("staging")).toBe("staging-sha");
  expect(repo.frozenBranches.has("staging")).toBe(false);
  expect(repo.pr.get(1)?.base).toBe("staging");
  expect(repo.statuses.get("feature-sha")).toBeNull();
  repo.conflict = false;
  expect((await coordinator.run("bootstrap")).active).toBe(
    "staging-2026-W45-1",
  );
});

test("Monday rollover carries all unpublished changes and supersedes old release", async () => {
  const repo = new Memory();
  const old = await new Coordinator(repo, options, 999).run("bootstrap");
  const nextOptions = { ...options, now: new Date("2026-11-09T06:15:00Z") };
  const next = await new Coordinator(repo, nextOptions, 999).run("reconcile");
  expect(next.active).toBe("staging-2026-W46-1");
  expect(repo.refs.get(next.active)).toBe("staging-sha");
  expect(repo.pr.get(old.release ?? 0)?.open).toBe(false);
  expect(repo.pr.get(1)?.base).toBe(next.active);
});

test("unexpected edits after the published snapshot are retained and block handover", async () => {
  const repo = new Memory();
  const coordinator = new Coordinator(repo, options, 999);
  let state = await coordinator.run("bootstrap");
  const pull = repo.pr.get(state.release ?? 0);
  if (!pull) throw new Error("No release");
  pull.draft = false;
  state = await coordinator.run("reconcile");
  pull.merged = true;
  pull.open = false;
  repo.refs.set(state.active, "unpublished-late-edit");
  await expect(coordinator.run("reconcile")).rejects.toThrow("snapshot");
  expect(repo.refs.get(state.active)).toBe("unpublished-late-edit");
  expect(repo.refs.has("staging-2026-W45-2")).toBe(false);
});

test("real Git squash releases preserve pending feature diffs across multiple numbered batches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "release-batch-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  class GitMemory extends Memory {
    override async branch(name: string) {
      const result = spawnSync(
        "git",
        ["rev-parse", "--verify", `refs/heads/${name}`],
        { cwd: directory, encoding: "utf8" },
      );
      return result.status === 0 ? result.stdout.trim() : null;
    }
    override async createBranch(name: string, sha: string) {
      git("branch", name, sha);
      this.refs.set(name, sha);
    }
    override async merge(base: string, head: string) {
      git("switch", base);
      const result = spawnSync("git", ["merge", "--no-edit", head], {
        cwd: directory,
        encoding: "utf8",
      });
      if (result.status !== 0) {
        git("merge", "--abort");
        return false;
      }
      const sha = git("rev-parse", base);
      this.refs.set(base, sha);
      for (const pull of this.pr.values())
        if (pull.head === base && pull.open) pull.sha = sha;
      return true;
    }
    override async sameTree(left: string, right: string) {
      return (
        git("rev-parse", `${left}^{tree}`) ===
        git("rev-parse", `${right}^{tree}`)
      );
    }
  }
  try {
    git("init", "--initial-branch=main");
    git("config", "user.name", "Release test");
    git("config", "user.email", "release-test@example.invalid");
    writeFileSync(join(directory, "base.txt"), "base\n");
    git("add", ".");
    git("commit", "-m", "Base");
    git("switch", "-c", "staging");
    writeFileSync(join(directory, "approved.txt"), "approved A\n");
    git("add", ".");
    git("commit", "-m", "Approved A");
    git("switch", "-c", "feature/a");
    writeFileSync(join(directory, "feature.txt"), "pending B\n");
    git("add", ".");
    git("commit", "-m", "Pending B");
    const repo = new GitMemory();
    for (const branch of ["main", "staging", "feature/a"])
      repo.refs.set(branch, git("rev-parse", branch));
    repo.pr.set(1, repo.makePull(1, "feature/a", "staging"));
    const coordinator = new Coordinator(repo, options, 999);
    let state = await coordinator.run("bootstrap");
    const publish = async () => {
      const release = repo.pr.get(state.release ?? 0);
      if (!release) throw new Error("Release not created");
      release.draft = false;
      state = await coordinator.run("reconcile");
      git("switch", "main");
      git("merge", "--squash", state.active);
      git("commit", "-m", `Publish ${state.active}`);
      release.merged = true;
      release.open = false;
      state = await coordinator.run("reconcile");
    };
    await publish();
    expect(state.active).toBe("staging-2026-W45-2");
    expect(git("diff", "--name-only", "main...feature/a")).toBe("feature.txt");
    expect(repo.pr.get(1)?.base).toBe(state.active);
    await repo.merge(state.active, "feature/a");
    const feature = repo.pr.get(1);
    if (feature) feature.open = false;
    state = await coordinator.run("reconcile");
    await publish();
    expect(state.active).toBe("staging-2026-W45-3");
    expect(git("show", "main:approved.txt")).toBe("approved A");
    expect(git("show", "main:feature.txt")).toBe("pending B");
    expect(state.release).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("handover never synchronizes a PR source into the production branch", async () => {
  const repo = new Memory();
  repo.pr.set(2, repo.makePull(2, "main", "staging"));
  await expect(
    new Coordinator(repo, options, 999).run("bootstrap"),
  ).rejects.toThrow("reserved source");
  expect(repo.refs.get("main")).toBe("main-sha");
});
