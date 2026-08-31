"""AT-SPI helpers run inside the e2e VM via SSH heredoc.

Shared preamble + generic tree-walk driven by callers passing a predicate and
an action expression; see atspi.ts for the JS side.
"""

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402


def walk_tree(predicate, action):
    """Depth-first walk of the desktop a11y tree; return action(node) on first predicate match."""
    # ponytail: depth 35 — GTK4 prefs nesting puts suffix buttons ~28 deep;
    # 25 cut off just above them (root-cause of 'Add Word has no click action')
    max_depth = 35
    d = Atspi.get_desktop(0)
    result = None

    def walk(node, depth=0):
        nonlocal result
        if node is None or depth > max_depth or result:
            return
        try:
            name = (node.get_name() or "").strip()
            role = node.get_role_name()
            if predicate(name, role, node):
                result = action(name, role, node)
                if result:
                    return
        except Exception:
            return
        try:
            n = node.get_child_count()
        except Exception:
            return
        for i in range(n):
            walk(node.get_child_at_index(i), depth + 1)

    for i in range(d.get_child_count()):
        walk(d.get_child_at_index(i))
        if result:
            break
    return result


def set_text_by_name(name, text):
    """Set text contents on the first Text-interface node matching name."""
    def predicate(n, r, node):
        return n == name

    def action(n, r, node):
        node.query_text().set_text_contents(text)
        return "ok"

    return walk_tree(predicate, action)
