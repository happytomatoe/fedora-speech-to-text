import { join } from "node:path";

// Python helpers live in atspi.py next to this file; loaded once and prepended
// to every one-shot script sent over SSH (python3 - reads the heredoc stdin).
const ATSPI_PY = await Bun.file(join(import.meta.dir, "atspi.py")).text();

export interface AtspiNode {
  name: string;
  role: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface Extents {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ExecLike {
  exec: (
    cmd: string,
    opts?: Record<string, unknown>
  ) => Promise<string | { stdout: string; stderr: string; code: number }>;
}

/** Normalize deployer.exec result to plain stdout text. */
function execText(deployer: ExecLike, cmd: string): Promise<string> {
  return deployer.exec(cmd).then((r) =>
    typeof r === "string" ? r : r.stdout
  );
}

/** Escape a string for single-quoted Python literal. */
function pyQuote(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Build a one-shot Python script that walks the a11y tree and prints matches. */
function treeScript(predicate: string, action: string): string {
  return `${ATSPI_PY}
result = walk_tree(
    lambda name, role, node: ${predicate},
    lambda name, role, node: ${action},
)
print("RESULT:" + str(result or ""))
`;
}

/** Exact-match clause for a node name inside the tree-walk predicate. */
function matchClause(nameVar: string, pattern: string): string {
  return `${nameVar} == '${pyQuote(pattern)}'`;
}

/** Run a Python heredoc on the VM session bus and return its stdout. */
function execPython(deployer: ExecLike, script: string): Promise<string> {
  return execText(
    deployer,
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); python3 - <<'ATSPIEOF'\n${script}\nATSPIEOF`
  );
}

/** Extract the RESULT: marker line from script output. */
function parseResult(output: string): string {
  const line = output.split("\n").find((l) => l.startsWith("RESULT:"));
  return line ? line.slice(7) : "";
}

/**
 * Wait until the a11y tree contains a node matching name/role, polling over SSH.
 * Poll interval 250ms — SSH round-trip + python startup dominates; don't pile up.
 */
export async function waitForAtspiNode(
  deployer: ExecLike,
  opts: { name: string; role?: string; timeoutMs?: number }
): Promise<AtspiNode> {
  const { name, role, timeoutMs = 10000 } = opts;
  const roleCheck = role ? `and role == '${pyQuote(role)}'` : "";
  const script = treeScript(
    `name and ${matchClause("name", name)} ${roleCheck}`,
    `f"{name}|{role}"`
  );
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const out = await execPython(deployer, script);
      const res = parseResult(out);
      if (res) {
        const [n, r] = res.split("|");
        return { name: n, role: r };
      }
      lastErr = "no match";
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `AT-SPI: node '${name}' (role=${role ?? "any"}) not found within ${timeoutMs}ms — last: ${lastErr}`
  );
}

/** Get screen coordinates of a named node (for dotool clicks at real positions). */
export async function findAtspiExtents(
  deployer: ExecLike,
  name: string
): Promise<Extents> {
  const script = treeScript(
    matchClause("name", name),
    `",".join(str(v) for v in (lambda e: (e.x, e.y, e.width, e.height))(node.get_component().get_extents(Atspi.CoordType.WINDOW)))`
  );
  const out = await execPython(deployer, script);
  const res = parseResult(out);
  if (!res) throw new Error(`AT-SPI: no extents for '${name}'`);
  const [x, y, width, height] = res.split(",").map(Number);
  if ([x, y, width, height].some((v) => Number.isNaN(v))) {
    throw new Error(`AT-SPI: bad extents for '${name}': ${res}`);
  }
  return { x, y, width, height };
}

/** Invoke a named action on a node (e.g. buttons expose "click"). */
export async function doAtspiAction(
  deployer: ExecLike,
  name: string,
  action = "click"
): Promise<void> {
  const script = treeScript(
    matchClause("name", name),
    `"ok" if node.do_action(next(i for i in range(node.get_n_actions()) if node.get_action_name(i) == '${pyQuote(action)}')) else "done"`
  );
  const out = await execPython(deployer, script);
  const res = parseResult(out);
  if (!res) throw new Error(`AT-SPI: node '${name}' has no '${action}' action`);
}

/** Poll until a node's text (Text interface) equals expected — used after SetTextContents. */
export async function waitForAtspiText(
  deployer: ExecLike,
  name: string,
  expected: string,
  timeoutMs = 5000
): Promise<void> {
  const script = treeScript(
    matchClause("name", name),
    `"true" if node.query_text().get_text(0, -1) == '${pyQuote(expected)}' else ""`
  );
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const out = await execPython(deployer, script);
    if (parseResult(out) === "true") return;
    await Bun.sleep(100);
  }
  throw new Error(`AT-SPI: text of '${name}' never became '${expected}'`);
}

/** Set text contents on the first Text-interface node matching name. */
export async function setAtspiTextByRole(
  deployer: ExecLike,
  role: string,
  text: string
): Promise<void> {
  const script = `${ATSPI_PY}
print("RESULT:" + str(set_text_by_role(['text', 'text entry', 'entry'], '${pyQuote(text)}') or ""))
`;
  const out = await execPython(deployer, script);
  if (parseResult(out) !== "ok") {
    // Debug: list Text-interface nodes so role mismatches are diagnosable
    const dump = await execPython(deployer, `${ATSPI_PY}
print("RESULT:" + str(dump_text_nodes() or ""))
`);
    throw new Error(`AT-SPI: no '${role}' node to set '${text}' — text nodes: ${parseResult(dump)}`);
  }
}

export async function setAtspiText(
  deployer: ExecLike,
  name: string,
  text: string
): Promise<void> {
  const script = `${ATSPI_PY}
print("RESULT:" + str(set_text_by_name('${pyQuote(name)}', '${pyQuote(text)}') or ""))
`;
  const out = await execPython(deployer, script);
  if (parseResult(out) !== "ok") {
    throw new Error(`AT-SPI: no Text node '${name}' to set '${text}'`);
  }
}
