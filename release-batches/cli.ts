export async function command(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(args, {
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0)
    throw new Error(`${args[0]} ${args[1]} failed: ${stderr.trim()}`);
  return stdout.trim();
}

export async function gh<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const output = await command(
    [
      "gh",
      "api",
      path,
      "--method",
      method,
      ...(body === undefined ? [] : ["--input", "-"]),
    ],
    body === undefined ? undefined : JSON.stringify(body),
  );
  return output ? (JSON.parse(output) as T) : (undefined as T);
}

export function argumentsFor(argv: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === "--apply") values.set(argument, "true");
    else {
      if (
        !argument.startsWith("--") ||
        !argv[i + 1] ||
        argv[i + 1].startsWith("--")
      )
        throw new Error(`Missing value for ${argument}`);
      values.set(argument, argv[++i]);
    }
  }
  const repository = values.get("--repository") ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Pass --repository owner/name");
  return { repository, values };
}
