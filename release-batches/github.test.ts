import { expect, test } from "bun:test";
import { ApiError, GitHub, Repository } from "./github.ts";
import { freezeRule } from "./model.ts";

test("no-op merge accepts 204, conflicts return false, authorization failures propagate", async () => {
  for (const [code, result] of [
    [204, true],
    [409, false],
  ] as const) {
    const repo = new Repository(
      new GitHub(
        "private-token",
        async () => new Response(null, { status: code }),
      ),
      "example/site",
      "staging",
    );
    expect(await repo.merge("staging", "sha")).toBe(result);
  }
  const repo = new Repository(
    new GitHub(
      "private-token",
      async () => new Response(null, { status: 403 }),
    ),
    "example/site",
    "staging",
  );
  await expect(repo.merge("staging", "sha")).rejects.toBeInstanceOf(ApiError);
  await expect(repo.merge("staging", "sha")).rejects.not.toThrow(
    "private-token",
  );
});

test("paginates all open PRs rather than silently losing a page during handover", async () => {
  let pages = 0;
  const api = new GitHub("private-token", async (url) => {
    pages++;
    return Response.json(
      new URL(url).searchParams.get("page") === "1"
        ? Array.from({ length: 100 }, (_, id) => id)
        : [100],
    );
  });
  expect(await api.list("/repos/example/site/pulls?state=open")).toHaveLength(
    101,
  );
  expect(pages).toBe(2);
});

test("one frozen ruleset retains every retired batch while adding the next freeze", async () => {
  let updated: ReturnType<typeof freezeRule> | null = null;
  const previous = freezeRule("staging-2026-W44-1", 999);
  const repo = new Repository(
    new GitHub("private-token", async (url, init) => {
      if (init?.method === "PUT") {
        updated = JSON.parse(String(init.body));
        return Response.json({ id: 77 });
      }
      return Response.json(
        url.endsWith("/77")
          ? previous
          : [{ id: 77, name: previous.name, source_type: "Repository" }],
      );
    }),
    "example/site",
    "staging",
  );
  await repo.freeze(
    "staging-2026-W45-1",
    freezeRule("staging-2026-W45-1", 999),
  );
  expect(updated).toMatchObject({
    conditions: {
      ref_name: {
        include: [
          "refs/heads/staging-2026-W44-1",
          "refs/heads/staging-2026-W45-1",
        ],
      },
    },
  });
});

test("never commits state over a concurrent journal update", async () => {
  let writes = 0;
  const repo = new Repository(
    new GitHub("private-token", async (_url, init) => {
      if (init?.method !== "GET") writes++;
      return Response.json({ object: { sha: "concurrent-state" } });
    }),
    "example/site",
    "staging",
  );
  await expect(
    repo.save({ version: 1, active: "staging-2026-W45-1" }),
  ).rejects.toThrow("concurrently");
  expect(writes).toBe(0);
});
