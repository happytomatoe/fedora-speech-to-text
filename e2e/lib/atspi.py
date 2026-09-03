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


def add_word_roundtrip(word):
    """Single-process Add-Word flow: wait for dialog entry (editable text node
    inside the Add Custom Word window), set text, click Add, verify row.
    One process so the a11y tree is walked once with consistent state."""
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

    def find_entry(node, depth=0):
        # Search within the dialog subtree only; require a mapped (SHOWING)
        # editable text node — global walk matched hidden shell text nodes.
        if node is None or depth > 30:
            return None
        try:
            if node.get_role_name() in ("text", "text entry") and node.get_state_set().contains(Atspi.StateType.SHOWING):
                return node
        except Exception:
            return None
        try:
            n = node.get_child_count()
        except Exception:
            return None
        for i in range(n):
            found = find_entry(node.get_child_at_index(i), depth + 1)
            if found:
                return found
        return None

    entry = None
    for _ in range(20):
        entry = find_entry(dlg)
        if entry:
            break
        time.sleep(0.5)
    if not entry:
        return "no-entry"

    st = entry.get_state_set()
    state_names = [str(s) for s in (Atspi.StateType.EDITABLE, Atspi.StateType.FOCUSABLE, Atspi.StateType.FOCUSED, Atspi.StateType.ENABLED, Atspi.StateType.SHOWING) if st.contains(s)]
    entry_states = ",".join(state_names)
    try:
        iface_methods = ",".join(m for m in dir(entry) if "text" in m.lower() or "edit" in m.lower())
    except Exception:
        iface_methods = "?"
    set_ok = False
    set_err = ""
    for _ in range(6):
        try:
            entry.grab_focus()
            time.sleep(0.2)
        except Exception:
            pass
        try:
            if entry.set_text_contents(word):
                set_ok = True
                break
        except Exception as e:
            set_err = repr(e)
        try:
            if entry.insert_text(0, word, len(word)):
                set_ok = True
                break
        except Exception as e:
            set_err = repr(e)
        time.sleep(0.3)
    if not set_ok:
        return f"set-failed states={entry_states} methods={iface_methods} err={set_err[:160]}"
    try:
        if entry.query_text().get_text(0, -1) != word:
            return "set-failed"
    except Exception:
        return "set-failed"

    # Click the Add button (suggested-action) inside the dialog
    add_btn = None

    def pred(n, r, node):
        return n == "Add" and r == "push button"
    def act(n, r, node):
        node.do_action(0)
        return "clicked"
    result = walk_tree(pred, act)
    if not result:
        return "no-add-button"

    # Verify word row appears in prefs window
    def pred2(n, r, node):
        return n == word and r in ("list item", "label")
    def act2(n, r, node):
        return "found"
    for _ in range(20):
        if walk_tree(pred2, act2):
            return "ok"
        time.sleep(0.5)
    return "row-not-found"
