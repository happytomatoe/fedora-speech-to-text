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


def set_text_by_role(roles, text):
    """Set text contents on the first node with a matching role (GTK entry roles vary)."""
    def predicate(n, r, node):
        return r in roles

    def action(n, r, node):
        if node.query_text().set_text_contents(text):
            return "ok"
        return None

    return walk_tree(predicate, action)


def dump_text_nodes():
    """List name|role for every node exposing a Text interface (debug)."""
    def predicate(n, r, node):
        try:
            node.query_text()
            return True
        except Exception:
            return False

    def action(n, r, node):
        return f"{n}|{r}"

    return walk_tree(predicate, action)


def dump_tree(max_nodes=200):
    """List first max_nodes nodes as name|role (debug; no early exit)."""
    out = []
    d = Atspi.get_desktop(0)

    def walk(node, depth=0):
        if node is None or depth > 35 or len(out) >= max_nodes:
            return
        try:
            out.append(f"{(node.get_name() or '').strip()[:40]}|{node.get_role_name()}")
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
    return ";".join(out)


def verify_word_added(word):
    """After keyboard input lands in the focused entry: click Add, verify row.
    (Text set via AT-SPI is refused by GTK4 in this headless dialog — input
    comes from dotool keystrokes instead.)"""
    import time

    def find_frame():
        def pred(n, r, node):
            return n == "Add Custom Word" and r == "frame"
        def act(n, r, node):
            return node
        return walk_tree(pred, act)

    dlg = None
    for _ in range(20):
        dlg = find_frame()
        if dlg:
            break
        time.sleep(0.5)
    if not dlg:
        return "no-dialog"

    def pred(n, r, node):
        return n == "Add" and r == "push button"
    def act(n, r, node):
        node.do_action(0)
        return "clicked"
    if not walk_tree(pred, act):
        return "no-add-button"

    def pred2(n, r, node):
        return n == word and r in ("list item", "label")
    def act2(n, r, node):
        return "found"
    for _ in range(20):
        if walk_tree(pred2, act2):
            return "ok"
        time.sleep(0.5)
    return "row-not-found"
