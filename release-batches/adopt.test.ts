import { expect, test } from "bun:test";
import { mergeAdoption, updateOrganizationRuleset } from "./adopt.ts";
import { organizationRules } from "./model.ts";

test("adopting a second repository preserves only explicitly opted-in IDs", () => {
  const current = organizationRules([111], 999, [])[0];
  const desired = organizationRules([222], 999, [])[0];
  expect(
    mergeAdoption(current, desired, 222).conditions.repository_id
      ?.repository_ids,
  ).toEqual([111, 222]);
  expect(
    mergeAdoption(current, desired, 111).conditions.repository_id
      ?.repository_ids,
  ).toEqual([111]);
  expect(current.conditions.repository_id.repository_ids).toEqual([111]);
});

test("adoption refuses to modify other adopters' protections, App or disabled state", () => {
  const current = organizationRules([111], 999, [])[0];
  const desired = organizationRules([222], 999, [])[0];
  expect(() =>
    mergeAdoption({ ...current, enforcement: "disabled" }, desired, 222),
  ).toThrow("disabled");
  expect(() => mergeAdoption({ ...current, rules: [] }, desired, 222)).toThrow(
    "different protections",
  );
  expect(() =>
    mergeAdoption(
      { ...current, bypass_actors: [{ actor_type: "OrganizationAdmin" }] },
      desired,
      222,
    ),
  ).toThrow("different App");
});

test("bypass actor object key order is immaterial but array order and contents remain significant", () => {
  const desired = organizationRules([222], 999, [])[1];
  const current = {
    ...organizationRules([111], 999, [])[1],
    bypass_actors: [
      { bypass_mode: "always", actor_id: 999, actor_type: "Integration" },
    ],
  };
  expect(
    mergeAdoption(current, desired, 222).conditions.repository_id
      ?.repository_ids,
  ).toEqual([111, 222]);

  const actors = [
    ...desired.bypass_actors,
    { actor_type: "Team", actor_id: 555, bypass_mode: "always" },
  ];
  const twoActors = { ...desired, bypass_actors: actors };
  for (const bypass_actors of [
    [...actors].reverse(),
    actors.slice(0, 1),
    [...actors, actors[0]],
    [{ ...actors[0], actor_id: 1000 }, actors[1]],
  ]) {
    expect(() =>
      mergeAdoption({ ...current, bypass_actors }, twoActors, 222),
    ).toThrow("different App");
  }
});

test("each shared ruleset PUT preserves repositories added since the plan or earlier write", async () => {
  const path = "orgs/example/rulesets/42";
  const planned = mergeAdoption(
    organizationRules([111], 999, [])[0],
    organizationRules([222], 999, [])[0],
    222,
  );
  let latest = organizationRules([111, 333], 999, [])[0];
  const calls: { path: string; method: string }[] = [];
  async function request<T>(
    requestedPath: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    calls.push({ path: requestedPath, method });
    if (method === "GET") return structuredClone(latest) as T;
    latest = body as typeof latest;
    return { id: 42 } as T;
  }

  await updateOrganizationRuleset(path, planned, 222, request);
  expect(latest.conditions.repository_id.repository_ids).toEqual([
    111, 333, 222,
  ]);
  latest.conditions.repository_id.repository_ids.push(444);
  await updateOrganizationRuleset(path, planned, 222, request);
  expect(latest.conditions.repository_id.repository_ids).toEqual([
    111, 333, 222, 444,
  ]);
  expect(calls).toEqual([
    { path, method: "GET" },
    { path, method: "PUT" },
    { path, method: "GET" },
    { path, method: "PUT" },
  ]);
});

test("fresh shared-rule safeguards stop unsafe changes before PUT", async () => {
  const desired = organizationRules([222], 999, [])[1];
  const current = organizationRules([111], 999, [])[1];
  const changed = [
    { ...current, rules: [] },
    { ...current, enforcement: "disabled" },
    { ...current, bypass_actors: [] },
    { ...current, conditions: { ref_name: current.conditions.ref_name } },
  ];
  for (const latest of changed) {
    const methods: string[] = [];
    async function request<T>(_path: string, method = "GET"): Promise<T> {
      methods.push(method);
      return latest as T;
    }
    await expect(
      updateOrganizationRuleset(
        "orgs/example/rulesets/42",
        desired,
        222,
        request,
      ),
    ).rejects.toThrow();
    expect(methods).toEqual(["GET"]);
  }
});
