import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';

const TypeTextIface = `
<node>
  <interface name="com.happytomatoe.TypeText">
    <method name="TypeText">
      <arg type="s" name="text" direction="in"/>
    </method>
  </interface>
</node>`;

export class TypeTextService {
    constructor() {
        this._virtualKeyboard = null;
        this._dbusImpl = null;
        this._ownerId = null;
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
                    const keyval = Clutter.unicode_to_keyval(charCode);
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
}
