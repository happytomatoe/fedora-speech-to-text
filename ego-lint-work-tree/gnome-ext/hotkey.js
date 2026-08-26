import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export function registerHotkey(name, settings, callback) {
    const hotkeyArr = settings.get_strv(name);
    const hotkeyValue = hotkeyArr && hotkeyArr.length > 0 ? hotkeyArr[0] : '';
    console.log(
        `VoiceToText: registerHotkey called, name=${name}, hotkey=${hotkeyValue}`
    );

    try {
        Main.wm.addKeybinding(
            name,
            settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                console.log(`VoiceToText: hotkey ${hotkeyValue} pressed!`);
                callback();
            }
        );
        console.log(
            `VoiceToText: hotkey '${hotkeyValue}' registered successfully`
        );
    } catch (e) {
        console.error(
            `VoiceToText: failed to register hotkey '${hotkeyValue}': ${e.message}`
        );
    }
}

export function unregisterHotkey(name) {
    Main.wm.removeKeybinding(name);
}
