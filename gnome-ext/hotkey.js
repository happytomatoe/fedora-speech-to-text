import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export function registerHotkey(name, settings, callback) {
  const hotkeyArr = settings.get_strv(name);
  const hotkeyValue = hotkeyArr && hotkeyArr.length > 0 ? hotkeyArr[0] : '';

  try {
    Main.wm.addKeybinding(
      name,
      settings,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
      () => {
        callback();
      }
    );
  } catch (e) {
    console.error(
      `VoiceToText: failed to register hotkey '${hotkeyValue}': ${e.message}`
    );
    throw e; // let caller (extension) show the failure notification
  }
}

export function unregisterHotkey(name) {
  Main.wm.removeKeybinding(name);
}
