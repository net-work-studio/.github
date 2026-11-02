import { describe, expect, test } from "bun:test";
import {
  freezeRule,
  isoWeek,
  type Options,
  organizationRules,
  type Pull,
  policy,
  rolloverDue,
  type State,
  successor,
  validateState,
} from "./model.ts";

const options: Options = {
  repository: "example/site",
  production: "main",
  legacy: "staging",
  timezone: "Europe/Zurich",
  now: new Date("2026-11-04T10:00:00Z"),
};
const state: State = { version: 1, active: "staging-2026-W45-1" };
const feature: Pull = {
  number: 1,
  base: state.active,
  head: "feature/a",
  sha: "abc",
  repository: options.repository,
  draft: false,
  merged: false,
  open: true,
};

describe("calendar and numbered batches", () => {
  test("uses ISO week-year, including previous year at January 1", () => {
    expect(isoWeek(new Date("2021-01-01T12:00:00Z"), options.timezone)).toBe(
      "2020-W53",
    );
    expect(isoWeek(new Date("2025-12-29T12:00:00Z"), options.timezone)).toBe(
      "2026-W01",
    );
  });
  test("uses Zurich local date at the week boundary", () => {
    expect(isoWeek(new Date("2026-11-01T23:30:00Z"), options.timezone)).toBe(
      "2026-W45",
    );
    expect(isoWeek(new Date("2026-06-07T22:30:00Z"), options.timezone)).toBe(
      "2026-W24",
    );
  });
  test("increments batches after each publication, resets only on rollover", () => {
    expect(successor(state.active, options, false)).toBe("staging-2026-W45-2");
    const nextWeek = { ...options, now: new Date("2026-11-09T10:00:00Z") };
    expect(successor(state.active, nextWeek, false)).toBe("staging-2026-W45-2");
    expect(successor(state.active, nextWeek, true)).toBe("staging-2026-W46-1");
  });
  test("recovers a missed scheduled run after local 07:15, including DST", () => {
    for (const [before, after] of [
      ["2026-11-09T06:14:00Z", "2026-11-09T06:15:00Z"],
      ["2026-06-08T05:14:00Z", "2026-06-08T05:15:00Z"],
    ]) {
      expect(
        rolloverDue("staging-2026-W01-1", {
          ...options,
          now: new Date(before),
        }),
      ).toBe(false);
      expect(
        rolloverDue("staging-2026-W01-1", { ...options, now: new Date(after) }),
      ).toBe(true);
    }
  });
});

test("only active batch or hotfix can release, and batch must be frozen", () => {
  expect(policy(feature, state, options, false)).toBeNull();
  expect(policy({ ...feature, base: "main" }, state, options, false)).toContain(
    "Production releases",
  );
  expect(
    policy(
      { ...feature, base: "main", head: "hotfix/login" },
      state,
      options,
      false,
    ),
  ).toBeNull();
  const release = { ...feature, base: "main", head: state.active };
  expect(policy(release, state, options, false)).toContain("frozen");
  expect(policy(release, state, options, true)).toBeNull();
  expect(policy(feature, state, options, true)).toContain("frozen");
  expect(
    policy(
      feature,
      {
        ...state,
        transition: {
          from: state.active,
          to: "staging-2026-W45-2",
          carry: false,
        },
      },
      options,
      false,
    ),
  ).toContain("handover");
});

test("org rules target explicit repo IDs and never let admins bypass production", () => {
  const rules = organizationRules([123], 999, [
    { context: "Project checks", integration_id: 15368 },
  ]);
  for (const rule of rules)
    expect(rule.conditions.repository_id.repository_ids).toEqual([123]);
  expect(rules[0].bypass_actors).toEqual([]);
  expect(rules[1].bypass_actors).toEqual([
    { actor_type: "Integration", actor_id: 999, bypass_mode: "always" },
  ]);
  expect(JSON.stringify(rules[0])).toContain('"integration_id":999');
  expect(() => organizationRules([], 999, [])).toThrow("Explicit repository");
  expect(freezeRule(state.active, 999).rules[0].type).toBe("update");
});

test("rejects corrupt state without selecting an arbitrary active branch", () => {
  expect(() => validateState({ version: 1, active: "main" })).toThrow();
  expect(() =>
    validateState({
      ...state,
      transition: { from: "other", to: "staging-2026-W45-2", carry: true },
    }),
  ).toThrow();
  expect(() => validateState({ ...state, release: -1 })).toThrow();
});
