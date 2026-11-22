const ALLOWED = [
  /^#!.*/,
  /^\/\/\s*@ts-(check|expect-error|ignore|nocheck)/,
  /^\/\/\s*(eslint|oxlint|prettier|aislop)-/,
  /^\/\*!/,
];

function isAllowed(comment) {
  const text = comment.type === "Line" ? `//${comment.value}` : `/*${comment.value}*/`;
  return ALLOWED.some((pattern) => pattern.test(text));
}

function isDocBlock(comment) {
  return comment.type === "Block" && comment.value.startsWith("*");
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban comments in code: a why belongs in docs/adr/, a what is already in the code",
    },
    schema: [],
    messages: {
      comment:
        "Comments are not documentation. Delete it; if the reason is non-obvious, write an ADR in docs/adr/ (see 0001).",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (isDocBlock(comment) || isAllowed(comment)) continue;
          context.report({ loc: comment.loc, messageId: "comment" });
        }
      },
    };
  },
};

export default {
  meta: { name: "no-comments" },
  rules: { "no-comments": rule },
};
