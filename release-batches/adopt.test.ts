import { expect, test } from "bun:test";
import { mergeAdoption } from "./adopt.ts";
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
