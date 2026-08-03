import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

const TypeTextIface = `
<node>
  <interface name="com.happytomatoe.TypeText">
    <method name="TypeText">
      <arg type="s" name="text" direction="in"/>
    </method>
    <method name="SaveClipboard"/>
    <method name="PasteText">
      <arg type="s" name="text" direction="in"/>
    </method>
    <method name="RestoreClipboard"/>
  </interface>
</node>`;

export class TypeTextService {
    constructor() {
        this._virtualKeyboard = null;
        this._dbusImpl = null;
        this._ownerId = null;
        this._savedClipboard = null;
    }

    enable() {
        // Get virtual keyboard via Clutter
        try {
            const backend = Clutter.get_default_backend();
            const seat = backend.get_default_seat();
            this._virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            if (this._virtualKeyboard) {
                console.log('VoiceToText: TypeText virtual keyboard obtained');
            } else {
                console.log('VoiceToText: TypeText virtual keyboard not available');
            }
        } catch (e) {
            console.error('VoiceToText: TypeText failed to get virtual keyboard:', e);
        }

        // Claim bus name + export object
        try {
            this._ownerId = Gio.bus_own_name(
                Gio.BusType.SESSION,
                'com.happytomatoe.TypeText',
                Gio.BusNameOwnerFlags.NONE,
                (connection, _name) => {
                    // Bus acquired — export D-Bus object
                    try {
                        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(TypeTextIface, this);
                        this._dbusImpl.export(connection, '/com/happytomatoe/TypeText');
                        console.log('VoiceToText: TypeText D-Bus object exported at /com/happytomatoe/TypeText');
                    } catch (e) {
                        console.error('VoiceToText: TypeText D-Bus export failed:', e);
                    }
                },
                (connection, name) => {
                    console.log(`VoiceToText: bus name acquired: ${name}`);
                },
                (connection, _name) => {
                    console.error(`VoiceToText: bus name lost: ${_name}`);
                }
            );
            console.log('VoiceToText: bus_own_name called for com.happytomatoe.TypeText');
        } catch (e) {
            console.error('VoiceToText: bus_own_name failed:', e);
        }
    }

    disable() {
        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = null;
        }
        this._virtualKeyboard = null;
        this._savedClipboard = null;
    }

    TypeText(text) {
        if (!this._virtualKeyboard) {
            console.log('VoiceToText: TypeText virtual keyboard not available');
            return;
        }
        console.log(`VoiceToText: TypeText typing ${text.length} chars`);
        try {
            let time = Clutter.get_current_event_time() * 1000;
            for (const char of text) {
                if (char === '\n') {
                    this._virtualKeyboard.notify_keyval(time++, Clutter.KEY_Return, Clutter.KeyState.PRESSED);
                    this._virtualKeyboard.notify_keyval(time++, Clutter.KEY_Return, Clutter.KeyState.RELEASED);
                } else if (char === '\x08') {
                    // Handle backspace (U+0008) for diff-correction
                    this._virtualKeyboard.notify_keyval(time++, Clutter.KEY_BackSpace, Clutter.KeyState.PRESSED);
                    this._virtualKeyboard.notify_keyval(time++, Clutter.KEY_BackSpace, Clutter.KeyState.RELEASED);
                } else {
                    const charCode = char.charCodeAt(0);
                    const keyval = Clutter.unicode_to_keysym(charCode);
                    if (keyval !== 0) {
                        this._virtualKeyboard.notify_keyval(time++, keyval, Clutter.KeyState.PRESSED);
                        this._virtualKeyboard.notify_keyval(time++, keyval, Clutter.KeyState.RELEASED);
                    }
                }
            }
        } catch (e) {
            console.error('VoiceToText: TypeText failed:', e);
        }
    }

    SaveClipboard() {
        try {
            const clipboard = St.Clipboard.get_default();
            // get_text in GNOME 50 is async with callback — run nested main loop to wait
            let result = '';
            const loop = new GLib.MainLoop(null, false);
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
                result = text || '';
                loop.quit();
            });
            loop.run();
            this._savedClipboard = result;
            console.log('VoiceToText: SaveClipboard saved', this._savedClipboard.length, 'chars');
            return this._savedClipboard;
        } catch (e) {
            console.error('VoiceToText: SaveClipboard failed:', e);
            return '';
        }
    }

    PasteText(text) {
        try {
            const clipboard = St.Clipboard.get_default();
            // set_text takes a plain string (no GBytes needed)
            clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
            console.log(`VoiceToText: PasteText set clipboard to ${text.length} chars`);

            // Send Shift+Insert to paste
            let time = Clutter.get_current_event_time() * 1000;
            this._virtualKeyboard.notify_keyval(time++, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
            this._virtualKeyboard.notify_keyval(time++, Clutter.KEY_Insert, Clutter.KeyState.PRESSED);
            this._virtualKeyboard.notify_keyval(time++, Clutter.KEY_Insert, Clutter.KeyState.RELEASED);
            this._virtualKeyboard.notify_keyval(time++, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
            console.log('VoiceToText: PasteText sent Shift+Insert');
        } catch (e) {
            console.error('VoiceToText: PasteText failed:', e);
        }
    }

    RestoreClipboard() {
        try {
            const clipboard = St.Clipboard.get_default();
            if (this._savedClipboard !== null) {
                // set_text takes a plain string
                clipboard.set_text(St.ClipboardType.CLIPBOARD, this._savedClipboard);
                console.log('VoiceToText: RestoreClipboard restored', this._savedClipboard.length, 'chars');
            } else {
                // No saved content — set empty string (clear was removed in GNOME 50)
                clipboard.set_text(St.ClipboardType.CLIPBOARD, '');
                console.log('VoiceToText: RestoreClipboard cleared clipboard');
            }
            this._savedClipboard = null;
        } catch (e) {
            console.error('VoiceToText: RestoreClipboard failed:', e);
        }
    }
}
