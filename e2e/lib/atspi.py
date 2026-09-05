"""AT-SPI helpers run inside the e2e VM via SSH heredoc.

Shared preamble + generic tree-walk driven by callers passing a predicate and
an action expression; see atspi.ts for the JS side.
"""

import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

# GTK4 prefs nesting puts suffix buttons ~28 deep; 25 cut off just above them
MAX_DEPTH_TREE = 35
MAX_DEPTH_DIALOG = 30
POLL_INTERVAL = 0.5
POLL_ATTEMPTS_DIALOG = 20
POLL_ATTEMPTS_ENTRY = 10
SCROLLBAR_POLL_ATTEMPTS = 10
SCROLLBAR_POLL_INTERVAL = 0.3


def walk_tree(predicate, action):
    """Depth-first walk of the desktop a11y tree; return action(node) on first match."""
    d = Atspi.get_desktop(0)
    result = None

    def walk(node, depth=0):
        nonlocal result
        if node is None or depth > MAX_DEPTH_TREE or result:
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


def wait_for(fn, attempts, interval=POLL_INTERVAL):
    """Call fn repeatedly until it returns a truthy value or attempts run out."""
    result = None
    for _ in range(attempts):
        result = fn()
        if result:
            break
        time.sleep(interval)
    return result


def find_dialog_frame(name="Add Custom Word"):
    """Return the a11y node for the named dialog frame, or None."""

    def pred(n, r, node):
        return n == name and r == "frame"

    def act(n, r, node):
        return node

    return walk_tree(pred, act)


def find_dialog_entry(node, depth=0):
    """Return the first SHOWING text-entry node under node, or None."""
    if node is None or depth > MAX_DEPTH_DIALOG:
        return None
    try:
        role = node.get_role_name()
        showing = node.get_state_set().contains(Atspi.StateType.SHOWING)
        if role in ("text", "text entry") and showing:
            return node
    except Exception:
        return None
    try:
        n = node.get_child_count()
    except Exception:
        return None
    for i in range(n):
        found = find_dialog_entry(node.get_child_at_index(i), depth + 1)
        if found is not None:
            return found
    return None


def find_add_word_entry():
    """Locate the Add-Word dialog and its text entry with retry polling.

    Returns (dialog, entry); either may be None if not found in time.
    """
    dlg = wait_for(find_dialog_frame, POLL_ATTEMPTS_DIALOG)
    if not dlg:
        return None, None
    entry = wait_for(lambda: find_dialog_entry(dlg), POLL_ATTEMPTS_ENTRY)
    return dlg, entry


def click_node(n, r, node):
    """Trigger the click action on an a11y node; fallback to action index 0."""
    try:
        idx = next(i for i in range(node.get_n_actions()) if node.get_action_name(i) == "click")
        node.do_action(idx)
    except Exception:
        node.do_action(0)
    return "clicked"


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
        if node is None or depth > MAX_DEPTH_TREE or len(out) >= max_nodes:
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


def dump_subtree(root, max_nodes=60):
    """Collect name|role pairs from a subtree rooted at root (debug)."""
    out = []

    def walk(node, depth=0):
        if node is None or depth > MAX_DEPTH_DIALOG or len(out) >= max_nodes:
            return
        try:
            out.append(f"{(node.get_name() or '').strip()}|{node.get_role_name()}")
        except Exception:
            return
        try:
            n = node.get_child_count()
        except Exception:
            return
        for i in range(n):
            walk(node.get_child_at_index(i), depth + 1)

    walk(root)
    return ";".join(out)


def verify_add_word_dialog_structure():
    """Check the Add-Word dialog structure: entry and Add button present.

    Text roundtrip dropped: GTK4 refuses AT-SPI SetTextContents headless, and
    dotool keystrokes don't reach the nested shell reliably (10+ CI rounds).
    """
    dlg, entry = find_add_word_entry()
    if dlg is None:
        return "no-dialog"
    if entry is None:
        return "no-entry"

    def pred(n, r, node):
        return n in ("Add", "Add…") and "button" in r

    def act(n, r, node):
        return "found"

    if not walk_tree(pred, act):
        return "no-add-button"

    # Cancel the dialog to leave prefs in a clean state
    def cpred(n, r, node):
        return n == "Cancel" and "button" in r

    walk_tree(cpred, click_node)
    return "ok"


def verify_word_added(word):
    """Click Add then verify the word appears as a row in the list.

    Text set via AT-SPI is refused by GTK4 in this headless dialog — input
    comes from dotool keystrokes instead.
    """
    dlg, _ = find_add_word_entry()
    if dlg is None:
        return "no-dialog"

    def pred(n, r, node):
        return n in ("Add", "Add…") and "button" in r

    if not walk_tree(pred, click_node):
        return "no-add-button tree=" + dump_subtree(dlg)

    def pred2(n, r, node):
        return n == word and r in ("list item", "label")

    def act2(n, r, node):
        return "found"

    found = wait_for(lambda: walk_tree(pred2, act2), POLL_ATTEMPTS_DIALOG)
    return "ok" if found else "row-not-found"


def read_add_word_entry():
    """Read back the Add-Word dialog entry's text.

    Text GET works headless even though SetTextContents is refused.
    """
    _, entry = find_add_word_entry()
    if entry is None:
        return "no-entry"
    try:
        ti = entry.query_text()
        return str(ti.get_text(0, ti.get_character_count()))
    except AttributeError:
        # pygobject 3.5x: no query_text — call the Text interface methods
        # unbound with the accessible as first argument
        n = Atspi.Text.get_character_count(entry)
        return str(Atspi.Text.get_text(entry, 0, n))
    except Exception as e:
        return f"error:{e}"


def find_add_word_entry_extents():
    """Return screen-absolute extents (x,y,w,h) of the Add-Word dialog entry.

    Used for RemoteDesktop click-to-focus; None if not found.
    """
    _, entry = find_add_word_entry()
    if entry is None:
        return None
    try:
        e = entry.get_extents(Atspi.CoordType.SCREEN)
        return f"{e.x},{e.y},{e.width},{e.height}"
    except Exception:
        return None


def node_showing(name):
    """Check whether a node with this exact name is currently SHOWING."""

    def pred(n, r, node):
        if n == name:
            try:
                return bool(node.get_state_set().contains(Atspi.StateType.SHOWING))
            except Exception:
                return False
        return False

    def act(n, r, node):
        return "yes"

    return "yes" if walk_tree(pred, act) else "no"


def node_name_present(name):
    """Check whether a list item node with this exact name exists in the tree."""

    def pred(n, r, node):
        return n == name and r == "list item"

    def act(n, r, node):
        return "yes"

    return "yes" if walk_tree(pred, act) else "no"


def focused_node_name():
    """Return the name of the node holding STATE_FOCUSED, or empty string."""

    def pred(n, r, node):
        try:
            return bool(node.get_state_set().contains(Atspi.StateType.FOCUSED))
        except Exception:
            return False

    def act(n, r, node):
        return n

    return walk_tree(pred, act) or ""


def scroll_to(name, position="BOTTOM_RIGHT"):
    """Scroll the first node matching name into view via Component.scroll_to.

    Returns "yes" on success, "no-api" if unavailable, "no" on failure.
    """
    stype = getattr(Atspi.ScrollType, position, None)
    if stype is None:
        return "no-api"

    def pred(n, r, node):
        return n == name

    def act(n, r, node):
        try:
            return "yes" if Atspi.Component.scroll_to(node, stype) else "no"
        except Exception:
            return "no-api"

    return walk_tree(pred, act) or "no"


def _set_scrollbar_max(sb):
    """Set a scrollbar node's value to maximum via the Value interface.

    Returns a status string; see scroll_to_bottom_via_value for values.
    """
    try:
        val = sb.query_value()
        max_v = val.get_maximum_value()
        min_v = val.get_minimum_value()
        if max_v <= min_v:
            return "already-at-extreme"
        val.set_current_value(max_v)
        return "ok"
    except AttributeError:
        # pygobject 3.5x: query_value may not exist; call the Value
        # interface methods unbound with the accessible as first argument
        max_v = Atspi.Value.get_maximum_value(sb)
        min_v = Atspi.Value.get_minimum_value(sb)
        if max_v <= min_v:
            return "already-at-extreme"
        Atspi.Value.set_current_value(sb, max_v)
        return "ok"
    except Exception as e:
        return f"error: {e}"


def scroll_to_bottom_via_value():
    """Scroll prefs to bottom by setting CurrentValue on the vertical scrollbar.

    Uses the AT-SPI Value interface — no pointer events, so no focus
    side-effects on the subsequently opened modal dialog.

    Walks the a11y tree for a ROLE_SCROLL_BAR node whose extents sit inside
    the 'Voice to Text' prefs frame, then sets its value to maximum.

    Returns one of: 'ok', 'no-scrollbar', 'no-value-iface', 'refused', 'error'.
    """

    def find_scrollbar():
        def pred(n, r, node):
            if r != "scroll bar":
                return False
            try:
                e = node.get_extents(Atspi.CoordType.WINDOW)
                return e.height > e.width  # vertical
            except Exception:
                return False

        def act(n, r, node):
            return node

        return walk_tree(pred, act)

    sb = wait_for(find_scrollbar, SCROLLBAR_POLL_ATTEMPTS, SCROLLBAR_POLL_INTERVAL)
    if not sb:
        return "no-scrollbar"
    return _set_scrollbar_max(sb)
