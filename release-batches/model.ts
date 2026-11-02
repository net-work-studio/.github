export const stateBranch = "release-batch-state";
export const policyContext = "Release policy";

export interface Pull {
  number: number;
  base: string;
  head: string;
  sha: string;
  repository: string;
  draft: boolean;
  merged: boolean;
  open: boolean;
}

export interface Transition {
  from: string;
  to: string;
  carry: boolean;
}

export interface State {
  version: 1;
  active: string;
  release?: number;
  releaseSha?: string;
  transition?: Transition;
}

export interface Options {
  repository: string;
  production: string;
  timezone: string;
  legacy: string;
  now: Date;
}

export function isoWeek(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const date = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = date.getUTCFullYear();
  const week = Math.ceil(
    ((date.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7,
  );
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function parseBatch(branch: string) {
  const match = /^staging-(\d{4}-W\d{2})-([1-9]\d*)$/.exec(branch);
  if (!match) throw new Error(`Invalid release batch: ${branch}`);
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence)) throw new Error("Invalid batch number");
  return { week: match[1], sequence };
}

export function successor(
  active: string,
  options: Options,
  rollover: boolean,
): string {
  const current = parseBatch(active);
  const week = isoWeek(options.now, options.timezone);
  // Calendar changes alone do not retire a batch: the scheduled handover does.
  if (rollover && current.week !== week) return `staging-${week}-1`;
  return `staging-${current.week}-${current.sequence + 1}`;
}

export function rolloverDue(active: string, options: Options): boolean {
  if (parseBatch(active).week === isoWeek(options.now, options.timezone))
    return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: options.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(options.now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return (
    get("weekday") !== "Mon" ||
    Number(get("hour")) * 60 + Number(get("minute")) >= 7 * 60 + 15
  );
}

export function validateState(value: unknown, legacy = "staging"): State {
  if (!value || typeof value !== "object")
    throw new Error("Missing release state");
  const state = value as State;
  if (state.version !== 1) throw new Error("Unsupported release state version");
  if (state.active !== legacy) parseBatch(state.active);
  if (
    state.release !== undefined &&
    (!Number.isSafeInteger(state.release) || state.release < 1)
  ) {
    throw new Error("Invalid release PR number");
  }
  if (state.transition) {
    if (typeof state.transition.carry !== "boolean")
      throw new Error("Invalid transition");
    parseBatch(state.transition.to);
    if (state.transition.from !== state.active)
      throw new Error("Transition source is not active");
  }
  return state;
}

export function policy(
  pull: Pull,
  state: State,
  options: Options,
  frozen: boolean,
): string | null {
  if (pull.repository !== options.repository)
    return "Fork PRs require manual adoption into a local feature branch";
  if (state.transition)
    return "Batch handover in progress; retry after completion";
  if (pull.base === options.production) {
    if (pull.head.startsWith("hotfix/")) return null;
    if (pull.head !== state.active)
      return `Production releases must use ${state.active} or hotfix/*`;
    if (pull.draft)
      return "Mark the release ready for review to freeze its batch";
    return frozen ? null : "Release batch must be frozen before publication";
  }
  if (pull.base !== state.active)
    return `Feature PRs must target ${state.active}`;
  if (
    pull.head === options.production ||
    pull.head === options.legacy ||
    pull.head.startsWith("hotfix/")
  )
    return "Production and hotfix branches cannot be merged as ordinary features";
  if (frozen)
    return "Batch is frozen for release; return the release PR to draft to resume edits";
  if (pull.head.startsWith("staging-") || pull.head === stateBranch)
    return "A release batch cannot be a feature branch";
  return null;
}

export interface Check {
  context: string;
  integration_id?: number;
}

function appBypass(appId: number) {
  return [
    { actor_type: "Integration", actor_id: appId, bypass_mode: "always" },
  ];
}

export function freezeRule(branch: string, appId: number) {
  return {
    name: "Release batches: frozen",
    target: "branch",
    enforcement: "active",
    bypass_actors: appBypass(appId),
    conditions: {
      ref_name: { include: [`refs/heads/${branch}`], exclude: [] },
    },
    rules: [
      { type: "update", parameters: { update_allows_fetch_and_merge: false } },
      { type: "deletion" },
    ],
  };
}

export function organizationRules(
  repoIds: number[],
  appId: number,
  checks: Check[],
) {
  if (
    !repoIds.length ||
    repoIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )
    throw new Error("Explicit repository IDs required");
  if (!Number.isSafeInteger(appId) || appId <= 0)
    throw new Error("GitHub App ID required");
  const conditions = (refs: string[]) => ({
    repository_id: { repository_ids: repoIds },
    ref_name: { include: refs, exclude: [] },
  });
  const pull = (approvals: number) => ({
    type: "pull_request",
    parameters: {
      required_approving_review_count: approvals,
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_review_thread_resolution: true,
      allowed_merge_methods: approvals
        ? ["squash", "rebase"]
        : ["merge", "squash", "rebase"],
    },
  });
  const status = {
    type: "required_status_checks",
    parameters: {
      required_status_checks: [
        ...checks,
        { context: policyContext, integration_id: appId },
      ],
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: true,
    },
  };
  return [
    {
      name: "Opt-in releases: production",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: conditions(["~DEFAULT_BRANCH"]),
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "required_linear_history" },
        pull(1),
        status,
      ],
    },
    {
      name: "Opt-in releases: batches",
      target: "branch",
      enforcement: "active",
      bypass_actors: appBypass(appId),
      conditions: conditions(["refs/heads/staging-*"]),
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        pull(0),
        status,
      ],
    },
    {
      name: "Opt-in releases: state",
      target: "branch",
      enforcement: "active",
      bypass_actors: appBypass(appId),
      conditions: conditions([`refs/heads/${stateBranch}`]),
      rules: [
        { type: "creation" },
        {
          type: "update",
          parameters: { update_allows_fetch_and_merge: false },
        },
        { type: "deletion" },
        { type: "non_fast_forward" },
      ],
    },
  ];
}
