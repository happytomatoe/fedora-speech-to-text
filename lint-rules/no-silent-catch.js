// Custom oxlint JS plugin rule: catch blocks must not be silent.
// Every catch body must contain a console.* call so failures are visible
// in CI logs. A comment is NOT sufficient — comments rot, logs persist.
const rule = {
  meta: { name: "no-silent-catch" },
  rules: {
    "no-silent-catch": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Require a console.* call inside every catch block so swallowed errors are visible in logs",
        },
        schema: [],
        messages: {
          silent:
            "Catch block is silent: add a console.error/console.warn (or a comment-free rethrow) so the failure is visible. A comment alone is not enough.",
        },
      },
      create(context) {
        return {
          CatchClause(node) {
            const body = node.body && node.body.body;
            if (!body || body.length === 0) {
              context.report({ node: node.body || node, messageId: "silent" });
              return;
            }
            const logs = body.some(
              (stmt) =>
                stmt.type === "ExpressionStatement" &&
                stmt.expression &&
                stmt.expression.type === "CallExpression" &&
                stmt.expression.callee &&
                stmt.expression.callee.type === "MemberExpression" &&
                stmt.expression.callee.object &&
                stmt.expression.callee.object.type === "Identifier" &&
                stmt.expression.callee.object.name === "console"
            );
            const rethrows = body.some((stmt) => stmt.type === "ThrowStatement");
            if (!logs && !rethrows) {
              context.report({ node: node.body, messageId: "silent" });
            }
          },
        };
      },
    },
  },
};

export default { meta: { name: "no-silent-catch" }, rules: rule.rules };
