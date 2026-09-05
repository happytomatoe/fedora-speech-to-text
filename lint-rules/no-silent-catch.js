// Custom oxlint JS plugin rule: catch blocks must not be silent.
// Every catch body (try/catch or promise .catch) must contain a console.*
// call so failures are visible in CI logs. A comment is NOT sufficient —
// comments rot, logs persist. A top-level rethrow also satisfies the rule.
function hasConsoleCall(node) {
  if (!node || typeof node !== "object") return false;
  if (
    node.type === "CallExpression" &&
    node.callee &&
    node.callee.type === "MemberExpression" &&
    node.callee.object &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "console"
  ) {
    return true;
  }
  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "range" || key === "loc") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c.type === "string" && hasConsoleCall(c)) return true;
      }
    } else if (child && typeof child === "object" && typeof child.type === "string") {
      if (hasConsoleCall(child)) return true;
    }
  }
  return false;
}

function checkCatchBody(context, bodyNode) {
  if (!bodyNode) {
    context.report({ node: bodyNode, messageId: "silent" });
    return;
  }
  // Block body: check statements. Expression body (concise arrow): the
  // expression itself must be the console call or a throw.
  const body = Array.isArray(bodyNode.body) ? bodyNode.body : [bodyNode];
  if (body.length === 0) {
    context.report({ node: bodyNode, messageId: "silent" });
    return;
  }
  const logs = body.some((stmt) => hasConsoleCall(stmt));
  const rethrows = body.some((stmt) => stmt.type === "ThrowStatement");
  if (!logs && !rethrows) {
    context.report({ node: bodyNode, messageId: "silent" });
  }
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a console.* call inside every catch block or .catch() handler so swallowed errors are visible in logs",
    },
    schema: [],
    messages: {
      silent:
        "Catch block is silent: add a console.error/console.warn (or a top-level rethrow) so the failure is visible. A comment alone is not enough.",
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        checkCatchBody(context, node.body);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee &&
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property &&
          callee.property.name === "catch" &&
          node.arguments.length > 0
        ) {
          const handler = node.arguments[0];
          if (handler && (handler.type === "ArrowFunctionExpression" || handler.type === "FunctionExpression")) {
            checkCatchBody(context, handler.body);
          }
        }
      },
    };
  },
};

export default {
  meta: { name: "no-silent-catch" },
  rules: { "no-silent-catch": rule },
};
