# Open Source References

This folder contains cloned repositories for API reference and development.

## GNOME Shell

Used to inspect internal APIs like `Main.inputMethod.commit()`.

- **Repo:** https://gitlab.gnome.org/GNOME/gnome-shell
- **Branch:** `gnome-50` (matches our target: GNOME 45-50)

```bash
cd opensrc
git clone --depth 1 --branch gnome-50 https://gitlab.gnome.org/GNOME/gnome-shell.git
```

### Key files to inspect

- `js/misc/inputMethod.js` — InputMethod class (wraps IBus, calls `this.commit()`)
- `js/ui/main.js` — Main module (exports `Main.inputMethod`)
- `js/ui/keyboard.js` — Virtual keyboard implementation

## Clutter InputMethod API

Source: `/usr/lib64/mutter-18/Clutter-18.gir` (line 27914)

```c
// C API
void clutter_input_method_commit(ClutterInputMethod *im, const gchar *text);
```

In GJS (GNOME Shell extensions):

```javascript
// From GNOME Shell's inputMethod.js
_onCommitText(_context, text) {
    this.commit(text.get_text());
}

// Usage from extension:
Main.inputMethod.commit('Hello world');
```

This is the recommended way for input methods to commit text to applications. It bypasses keystroke simulation entirely and works reliably in all contexts (including nested shells).
