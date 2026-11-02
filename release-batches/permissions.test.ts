import { expect, test } from "bun:test";
import { appManifest } from "./register-app.ts";

interface Workflow {
  jobs: {
    reconcile: {
      steps: { uses?: string; with?: Record<string, string> }[];
    };
  };
}

test("workflow-changing merges have matching App grants and requested token permissions", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(
      new URL("../.github/workflows/release-batches.yml", import.meta.url),
    ).text(),
  ) as Workflow;
  const token = workflow.jobs.reconcile.steps.find(
    (step) => step.uses === "actions/create-github-app-token@v2",
  );
  const inputs = token?.with ?? {};
  const requested = Object.fromEntries(
    Object.entries(inputs)
      .filter(([key]) => key.startsWith("permission-"))
      .map(([key, value]) => [
        key.slice("permission-".length).replaceAll("-", "_"),
        value,
      ]),
  );
  const manifest = appManifest("example", "http://127.0.0.1:3000", "nonce");

  expect(manifest.default_permissions.workflows).toBe("write");
  expect(requested.workflows).toBe("write");
  expect(requested).toEqual(manifest.default_permissions);
  expect(inputs.owner).toBe("${{ github.repository_owner }}");
  expect(inputs.repositories).toBe("${{ github.event.repository.name }}");
});
