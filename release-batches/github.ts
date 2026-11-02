import {
  type freezeRule,
  type Pull,
  policyContext,
  type State,
  stateBranch,
  validateState,
} from "./model.ts";

export class ApiError extends Error {
  constructor(
    public status: number,
    method: string,
    path: string,
  ) {
    super(`GitHub ${method} ${path} failed (${status})`);
  }
}

export class GitHub {
  constructor(
    private token: string,
    private transport: (
      url: string,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.transport(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new ApiError(response.status, method, path);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async optional<T>(path: string): Promise<T | null> {
    try {
      return await this.request<T>("GET", path);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async list<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    for (let page = 1; ; page++) {
      const items = await this.request<T[]>(
        "GET",
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      results.push(...items);
      if (items.length < 100) return results;
    }
  }
}

interface GitHubPull {
  number: number;
  base: { ref: string };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  draft: boolean;
  state: string;
  merged?: boolean;
}

function toPull(value: GitHubPull): Pull {
  return {
    number: value.number,
    base: value.base.ref,
    head: value.head.ref,
    sha: value.head.sha,
    repository: value.head.repo?.full_name ?? "",
    draft: value.draft,
    merged: value.merged ?? false,
    open: value.state === "open",
  };
}

export class Repository {
  private path: string;
  private stateSha: string | null = null;

  constructor(
    public api: GitHub,
    public name: string,
    private legacy: string,
  ) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(name))
      throw new Error("Invalid repository name");
    this.path = `/repos/${name}`;
  }

  async branch(name: string): Promise<string | null> {
    const ref = await this.api.optional<{ object: { sha: string } }>(
      `${this.path}/git/ref/heads/${encodeURIComponent(name)}`,
    );
    return ref?.object.sha ?? null;
  }

  async createBranch(name: string, sha: string) {
    await this.api.request("POST", `${this.path}/git/refs`, {
      ref: `refs/heads/${name}`,
      sha,
    });
  }

  async load(): Promise<State | null> {
    this.stateSha = await this.branch(stateBranch);
    if (!this.stateSha) return null;
    const file = await this.api.request<{ content: string }>(
      "GET",
      `${this.path}/contents/state.json?ref=${this.stateSha}`,
    );
    return validateState(
      JSON.parse(Buffer.from(file.content, "base64").toString()),
      this.legacy,
    );
  }

  async save(state: State) {
    const before = await this.branch(stateBranch);
    if (before !== this.stateSha)
      throw new Error(
        "Release state changed concurrently; rerun reconciliation",
      );
    const tree = await this.api.request<{ sha: string }>(
      "POST",
      `${this.path}/git/trees`,
      {
        tree: [
          {
            path: "state.json",
            mode: "100644",
            type: "blob",
            content: `${JSON.stringify(state, null, 2)}\n`,
          },
        ],
      },
    );
    const commit = await this.api.request<{ sha: string }>(
      "POST",
      `${this.path}/git/commits`,
      {
        message: "Record release batch handover",
        tree: tree.sha,
        parents: before ? [before] : [],
      },
    );
    if (before)
      await this.api.request(
        "PATCH",
        `${this.path}/git/refs/heads/${stateBranch}`,
        { sha: commit.sha, force: false },
      );
    else await this.createBranch(stateBranch, commit.sha);
    this.stateSha = commit.sha;
  }

  async merge(base: string, head: string): Promise<boolean> {
    try {
      await this.api.request("POST", `${this.path}/merges`, {
        base,
        head,
        commit_message: `Synchronize ${base} for release handover`,
      });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return false;
      throw error;
    }
  }

  async sameTree(left: string, right: string) {
    const tree = async (ref: string) =>
      (
        await this.api.request<{ tree: { sha: string } }>(
          "GET",
          `${this.path}/git/commits/${encodeURIComponent(ref)}`,
        )
      ).tree.sha;
    return (await tree(left)) === (await tree(right));
  }

  async pulls(): Promise<Pull[]> {
    return (
      await this.api.list<GitHubPull>(`${this.path}/pulls?state=open`)
    ).map(toPull);
  }

  async pull(number: number): Promise<Pull> {
    return toPull(
      await this.api.request<GitHubPull>("GET", `${this.path}/pulls/${number}`),
    );
  }

  async updatePull(number: number, values: { base?: string; state?: string }) {
    await this.api.request("PATCH", `${this.path}/pulls/${number}`, values);
  }

  async createRelease(head: string, base: string): Promise<Pull> {
    return toPull(
      await this.api.request<GitHubPull>("POST", `${this.path}/pulls`, {
        head,
        base,
        draft: true,
        title: `Release ${head}`,
        body: "Manually publish this release batch. Mark ready for review to freeze the batch, wait for checks and approval, then squash or rebase merge. Return to draft to resume collecting edits. The successor batch is created automatically after merging.",
      }),
    );
  }

  async rules() {
    return this.api.list<{ id: number; name: string; source_type: string }>(
      `${this.path}/rulesets?includes_parents=false`,
    );
  }

  private async freezeDefinition() {
    const rule = (await this.rules()).find(
      (item) => item.name === "Release batches: frozen",
    );
    if (!rule) return null;
    const { name, target, enforcement, bypass_actors, conditions, rules } =
      await this.api.request<ReturnType<typeof freezeRule>>(
        "GET",
        `${this.path}/rulesets/${rule.id}`,
      );
    return {
      id: rule.id,
      definition: {
        name,
        target,
        enforcement,
        bypass_actors,
        conditions,
        rules,
      },
    };
  }

  async frozen(branch: string) {
    const rule = await this.freezeDefinition();
    return (
      rule?.definition.enforcement === "active" &&
      rule.definition.conditions.ref_name.include.includes(
        `refs/heads/${branch}`,
      )
    );
  }

  async freeze(branch: string, rule: ReturnType<typeof freezeRule>) {
    const existing = await this.freezeDefinition();
    const includes = new Set(
      existing?.definition.conditions.ref_name.include ?? [],
    );
    includes.add(`refs/heads/${branch}`);
    rule.conditions.ref_name.include = [...includes];
    if (existing)
      await this.api.request(
        "PUT",
        `${this.path}/rulesets/${existing.id}`,
        rule,
      );
    else await this.api.request("POST", `${this.path}/rulesets`, rule);
  }

  async unfreeze(branch: string) {
    const existing = await this.freezeDefinition();
    if (!existing) return;
    const definition = existing.definition;
    definition.conditions.ref_name.include =
      definition.conditions.ref_name.include.filter(
        (ref) => ref !== `refs/heads/${branch}`,
      );
    if (definition.conditions.ref_name.include.length)
      await this.api.request(
        "PUT",
        `${this.path}/rulesets/${existing.id}`,
        definition,
      );
    else
      await this.api.request("DELETE", `${this.path}/rulesets/${existing.id}`);
  }

  async status(sha: string, error: string | null) {
    await this.api.request("POST", `${this.path}/statuses/${sha}`, {
      context: policyContext,
      state: error ? "failure" : "success",
      description: (error ?? "Release policy satisfied").slice(0, 140),
      ...(process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
        ? {
            target_url: `${process.env.GITHUB_SERVER_URL}/${this.name}/actions/runs/${process.env.GITHUB_RUN_ID}`,
          }
        : {}),
    });
  }
}
