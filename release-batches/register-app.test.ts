import { expect, test } from "bun:test";
import { appManifest } from "./register-app.ts";

test("installation updates return to the active setup callback on retry", () => {
  const manifest = appManifest(
    "example",
    "http://127.0.0.1:3000",
    "setup-nonce",
  );
  const setup = new URL(manifest.setup_url);

  expect(manifest).toHaveProperty("setup_on_update", true);
  expect(setup.origin).toBe("http://127.0.0.1:3000");
  expect(setup.pathname).toBe("/installed");
  expect(setup.searchParams.get("state")).toBe("setup-nonce");
});
