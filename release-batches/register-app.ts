import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { argumentsFor, command, gh } from "./cli.ts";
import { GitHub } from "./github.ts";

interface AppCredentials {
  id: number;
  pem: string;
  slug: string;
}

export function appManifest(owner: string, origin: string, nonce: string) {
  return {
    name: `${owner} release batches`.slice(0, 34),
    url: `https://github.com/${owner}/.github`,
    description:
      "Maintain explicitly opted-in staging batches; production review and checks remain required.",
    public: false,
    redirect_url: `${origin}/callback`,
    setup_url: `${origin}/installed?state=${nonce}`,
    setup_on_update: true,
    hook_attributes: {
      url: `https://github.com/${owner}/.github`,
      active: false,
    },
    default_permissions: {
      administration: "write",
      contents: "write",
      pull_requests: "write",
      statuses: "write",
      workflows: "write",
    },
    default_events: [],
  };
}

function jwt(id: number, pem: string) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const message = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 30, exp: now + 300, iss: id })}`;
  return `${message}.${sign("sha256", Buffer.from(message), createPrivateKey(pem)).toString("base64url")}`;
}

async function run() {
  const { repository } = argumentsFor(process.argv.slice(2));
  const [owner, name] = repository.split("/");
  const org = await gh<{ id: number }>(`orgs/${owner}`);
  const stored = await command([
    "gh",
    "secret",
    "list",
    "--org",
    owner,
    "--json",
    "name",
  ]);
  if (
    (JSON.parse(stored) as { name: string }[]).some(
      (secret) => secret.name === "RELEASE_APP_PRIVATE_KEY",
    )
  )
    throw new Error(
      "A release App key already exists; reuse the existing App instead of replacing other adopters' credentials",
    );
  const nonce = randomUUID();
  let credentials: AppCredentials | null = null;
  let converting = false;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.host !== `127.0.0.1:${server.port}`)
        return new Response("Invalid host", { status: 400 });
      const origin = `http://127.0.0.1:${server.port}`;
      try {
        if (url.pathname === "/") {
          const manifest = appManifest(owner, origin, nonce);
          const escaped = JSON.stringify(manifest)
            .replaceAll("&", "&amp;")
            .replaceAll("'", "&#39;")
            .replaceAll("<", "&lt;");
          return new Response(
            `<!doctype html><title>Release App setup</title><h1>Create the organization release App</h1><p>Install on ${repository} only. No production reviews or checks are bypassed.</p><form method="post" action="https://github.com/organizations/${owner}/settings/apps/new?state=${nonce}"><input type="hidden" name="manifest" value='${escaped}'><button>Create GitHub App</button></form>`,
            {
              headers: {
                "Content-Type": "text/html",
                "Cache-Control": "no-store",
              },
            },
          );
        }
        if (url.searchParams.get("state") !== nonce)
          return new Response("Invalid setup state", { status: 400 });
        if (url.pathname === "/callback") {
          if (converting || credentials)
            return new Response("App registration already received", {
              status: 409,
            });
          const code = url.searchParams.get("code");
          if (!code)
            return new Response("Missing registration code", { status: 400 });
          converting = true;
          const response = await fetch(
            `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
            {
              method: "POST",
              headers: { Accept: "application/vnd.github+json" },
            },
          );
          if (!response.ok)
            throw new Error("GitHub rejected the manifest conversion");
          credentials = (await response.json()) as AppCredentials;
          if (!credentials) throw new Error("Missing App credentials");
          return Response.redirect(
            `https://github.com/apps/${credentials.slug}/installations/new?target_id=${org.id}`,
          );
        }
        if (url.pathname === "/installed" && credentials) {
          const app = new GitHub(jwt(credentials.id, credentials.pem));
          const installation = await app.request<{
            id: number;
            repository_selection: string;
          }>("GET", `/repos/${repository}/installation`);
          if (
            installation.repository_selection !== "selected" ||
            String(installation.id) !== url.searchParams.get("installation_id")
          )
            throw new Error(
              "Choose Only select repositories and install on the intended repository",
            );
          const token = await app.request<{ token: string }>(
            "POST",
            `/app/installations/${installation.id}/access_tokens`,
            { permissions: { contents: "read" } },
          );
          const installed = new GitHub(token.token);
          const selection = await installed.request<{
            repositories: { full_name: string }[];
          }>("GET", "/installation/repositories?per_page=100");
          await installed.request("DELETE", "/installation/token");
          if (
            selection.repositories.length !== 1 ||
            selection.repositories[0].full_name !== repository
          )
            throw new Error(
              `Install the new App on ${repository} only before continuing`,
            );
          // The key only travels through a pipe into the selected-repository
          // organization secret. It is never printed or written to disk.
          await command(
            [
              "gh",
              "secret",
              "set",
              "RELEASE_APP_PRIVATE_KEY",
              "--org",
              owner,
              "--visibility",
              "selected",
              "--repos",
              name,
            ],
            credentials.pem,
          );
          await command([
            "gh",
            "variable",
            "set",
            "RELEASE_APP_ID",
            "--org",
            owner,
            "--visibility",
            "selected",
            "--repos",
            name,
            "--body",
            String(credentials.id),
          ]);
          credentials = null;
          finish();
          return new Response(
            "App installed; scoped credentials stored. Return to the setup wizard.",
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        process.stderr.write(
          `${error instanceof Error ? error.message : "Setup failed"}\n`,
        );
        return new Response(
          "Setup could not complete. Check the terminal, correct the installation and retry; no production protections were enabled.",
          { status: 400 },
        );
      }
    },
  });
  const address = `http://127.0.0.1:${server.port}`;
  process.stdout.write(
    `Approve App creation, then choose Only select repositories → ${repository}: ${address}\n`,
  );
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  try {
    await command([opener, address]);
  } catch {
    /* The printed URL is also usable manually. */
  }
  const timeout = setTimeout(
    () => {
      server.stop(true);
      process.stderr.write("App setup timed out; rerun the wizard.\n");
      process.exitCode = 1;
      finish();
    },
    15 * 60 * 1000,
  );
  await done;
  clearTimeout(timeout);
  await Bun.sleep(100);
  server.stop(true);
}

if (import.meta.main) await run();
