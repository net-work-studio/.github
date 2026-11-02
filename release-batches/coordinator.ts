import {
  freezeRule,
  isoWeek,
  type Options,
  type Pull,
  parseBatch,
  policy,
  rolloverDue,
  type State,
  stateBranch,
  successor,
} from "./model.ts";

export interface Port {
  branch(name: string): Promise<string | null>;
  createBranch(name: string, sha: string): Promise<void>;
  load(): Promise<State | null>;
  save(state: State): Promise<void>;
  merge(base: string, head: string): Promise<boolean>;
  sameTree(left: string, right: string): Promise<boolean>;
  pulls(): Promise<Pull[]>;
  pull(number: number): Promise<Pull>;
  updatePull(
    number: number,
    values: { base?: string; state?: string },
  ): Promise<void>;
  createRelease(head: string, base: string): Promise<Pull>;
  frozen(branch: string): Promise<boolean>;
  freeze(branch: string, rule: ReturnType<typeof freezeRule>): Promise<void>;
  unfreeze(branch: string): Promise<void>;
  status(sha: string, error: string | null): Promise<void>;
}

export type Operation = "reconcile" | "bootstrap" | "rollover";

export class CarryoverConflict extends Error {}

export class Coordinator {
  constructor(
    private repo: Port,
    private options: Options,
    private appId: number,
  ) {}

  private async requireBranch(branch: string) {
    const sha = await this.repo.branch(branch);
    if (!sha) throw new Error(`Required branch missing: ${branch}`);
    return sha;
  }

  private async freeze(branch: string) {
    await this.repo.freeze(branch, freezeRule(branch, this.appId));
  }

  private async bootstrap() {
    const { legacy, now, timezone } = this.options;
    const to = `staging-${isoWeek(now, timezone)}-1`;
    if (await this.repo.branch(to))
      throw new Error(`Bootstrap destination already exists: ${to}`);
    const from = (await this.repo.branch(legacy)) ? legacy : to;
    const state: State = {
      version: 1,
      active: from,
      transition: { from, to, carry: from !== to },
    };
    await this.repo.save(state);
    return state;
  }

  private async handover(state: State): Promise<State> {
    const transition = state.transition;
    if (!transition) return state;
    const { from, to, carry } = transition;
    if (await this.repo.branch(from)) await this.freeze(from);
    const productionSha = await this.requireBranch(this.options.production);
    if (!(await this.repo.branch(to)))
      await this.repo.createBranch(to, productionSha);
    await this.freeze(to);
    // Both sides stay frozen until every retarget has completed. Only the App
    // can perform these maintenance merges; no user commits are force-pushed.
    const mergeMain = await this.repo.merge(to, productionSha);
    const mergeCarry =
      mergeMain &&
      (!carry || (await this.repo.merge(to, await this.requireBranch(from))));
    if (!mergeCarry) {
      // Keep the failed destination for inspection/retry, with its edits intact.
      if (from !== to) await this.repo.unfreeze(from);
      const active: State = { ...state, transition: undefined };
      await this.repo.save(active);
      throw new CarryoverConflict(
        `Carryover conflicts: ${from} remains active; resolve against ${this.options.production} and retry rollover`,
      );
    }

    const superseded: number[] = [];
    for (const pull of await this.repo.pulls()) {
      if (pull.base === this.options.production && pull.head === from) {
        superseded.push(pull.number);
        continue;
      }
      const migrateLegacy =
        from === this.options.legacy &&
        pull.base === this.options.production &&
        !pull.head.startsWith("hotfix/");
      if (pull.base !== from && !migrateLegacy) continue;
      if (pull.repository === this.options.repository) {
        if (
          [this.options.production, this.options.legacy, stateBranch].includes(
            pull.head,
          ) ||
          pull.head.startsWith("staging-") ||
          pull.head.startsWith("hotfix/")
        ) {
          throw new Error(
            `PR #${pull.number} uses a reserved source branch; resolve it manually before handover`,
          );
        }
        // A conflict keeps the feature's original commits intact. Its required
        // up-to-date checks will block merging until its author resolves it.
        await this.repo.merge(pull.head, await this.requireBranch(to));
      }
      await this.repo.updatePull(pull.number, { base: to });
    }

    for (const number of superseded)
      await this.repo.updatePull(number, { state: "closed" });

    const next: State = { version: 1, active: to };
    await this.repo.save(next);
    await this.repo.unfreeze(to);
    return next;
  }

  private async release(state: State): Promise<State> {
    if (!state.release) return state;
    const pull = await this.repo.pull(state.release);
    if (pull.base !== this.options.production || pull.head !== state.active)
      throw new Error("Recorded release PR no longer matches its batch");
    if (pull.merged) {
      await this.freeze(state.active);
      const head = await this.requireBranch(state.active);
      if (
        !state.releaseSha ||
        head !== state.releaseSha ||
        pull.sha !== state.releaseSha
      ) {
        throw new Error(
          "Published batch revision does not match its frozen snapshot; retained branch requires manual reconciliation",
        );
      }
      const next: State = {
        ...state,
        transition: {
          from: state.active,
          to: successor(state.active, this.options, false),
          carry: false,
        },
      };
      await this.repo.save(next);
      return this.handover(next);
    }
    if (!pull.open) {
      await this.repo.unfreeze(state.active);
      const next: State = { version: 1, active: state.active };
      await this.repo.save(next);
      return next;
    }
    return state;
  }

  private async ensureRelease(state: State): Promise<State> {
    if (
      !state.release &&
      !(await this.repo.sameTree(
        await this.requireBranch(state.active),
        await this.requireBranch(this.options.production),
      ))
    ) {
      const existing = (await this.repo.pulls()).find(
        (pull) =>
          pull.base === this.options.production && pull.head === state.active,
      );
      const pull =
        existing ??
        (await this.repo.createRelease(state.active, this.options.production));
      state = { ...state, release: pull.number };
      await this.repo.save(state);
    }
    if (!state.release) {
      // Recover if the final unfreeze failed after the transition state saved.
      await this.repo.unfreeze(state.active);
      return state;
    }
    const pull = await this.repo.pull(state.release);
    if (pull.draft) {
      await this.repo.unfreeze(state.active);
      if (state.releaseSha) {
        state = { ...state, releaseSha: undefined };
        await this.repo.save(state);
      }
    } else {
      await this.freeze(state.active);
      const sha = await this.requireBranch(state.active);
      // A feature may land between ready_for_review and freezing; require the
      // latest PR revision and let normal CI/review dismissal run on that SHA.
      const current = await this.repo.pull(state.release);
      if (current.sha !== sha)
        throw new Error(
          "Release PR revision is still updating; rerun reconciliation",
        );
      if (state.releaseSha !== sha) {
        state = { ...state, releaseSha: sha };
        await this.repo.save(state);
      }
    }
    return state;
  }

  private async statuses(state: State) {
    const frozen = await this.repo.frozen(state.active);
    const bySha = new Map<string, string | null>();
    for (const pull of await this.repo.pulls()) {
      const failure = policy(pull, state, this.options, frozen);
      // Statuses attach to commits, not PR numbers. Fail closed when the same
      // revision is reused in an ineligible PR instead of overwriting a failure.
      bySha.set(pull.sha, bySha.get(pull.sha) || failure);
    }
    for (const [sha, failure] of bySha) await this.repo.status(sha, failure);
  }

  async run(operation: Operation) {
    let state = await this.repo.load();
    if (!state) {
      if (operation !== "bootstrap")
        throw new Error(
          "Release batches are not initialized; run bootstrap after installing protections",
        );
      state = await this.bootstrap();
    }
    try {
      if (state.active === this.options.legacy && !state.transition) {
        state = {
          ...state,
          transition: {
            from: state.active,
            to: `staging-${isoWeek(this.options.now, this.options.timezone)}-1`,
            carry: true,
          },
        };
        await this.repo.save(state);
      }
      state = await this.handover(state);
      state = await this.release(state);
      if (
        (operation === "rollover" || rolloverDue(state.active, this.options)) &&
        parseBatch(state.active).week !==
          isoWeek(this.options.now, this.options.timezone)
      ) {
        state = {
          ...state,
          transition: {
            from: state.active,
            to: successor(state.active, this.options, true),
            carry: true,
          },
        };
        await this.repo.save(state);
        state = await this.handover(state);
      }
      // A separately approved hotfix can advance main while a batch is open.
      // Sync through the App, then require CI and renewed approval if it changed.
      if (
        !(await this.repo.merge(
          state.active,
          await this.requireBranch(this.options.production),
        ))
      ) {
        await this.repo.unfreeze(state.active);
        throw new CarryoverConflict(
          "Active batch conflicts with production; resolve before releasing",
        );
      }
      state = await this.ensureRelease(state);
      await this.statuses(state);
      return state;
    } catch (error) {
      if (error instanceof CarryoverConflict) {
        // Allow a feature PR containing a human conflict resolution to merge
        // into the still-active batch. Publication remains blocked by its freeze gate.
        const current = await this.repo.load();
        if (current) await this.statuses(current);
        throw error;
      }
      // Never leave a previously successful policy status on a broken handover.
      for (const pull of await this.repo.pulls())
        await this.repo.status(
          pull.sha,
          "Release maintenance needs attention; inspect the workflow run",
        );
      throw error;
    }
  }
}
