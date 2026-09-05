import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const Iface = `
<node>
  <interface name="com.happytomatoe.E2EInput">
    <method name="TypeText">
      <arg type="s" name="text" direction="in"/>
    </method>
    <method name="TypeKey">
      <arg type="s" name="key" direction="in"/>
    </method>
    <method name="Move">
      <arg type="d" name="x" direction="in"/>
      <arg type="d" name="y" direction="in"/>
    </method>
    <method name="Click">
      <arg type="d" name="x" direction="in"/>
      <arg type="d" name="y" direction="in"/>
    </method>
    <method name="Wheel">
      <arg type="i" name="ticks" direction="in"/>
    </method>
    <method name="ActivateWindow">
      <arg type="s" name="title" direction="in"/>
    </method>
    <method name="Ping">
      <arg type="s" name="ignored" direction="in"/>
      <arg type="s" name="status" direction="out"/>
    </method>
  </interface>
</node>`;

export default class E2EInput {
    enable() {
        try {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._kbd = seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE
            );
            this._ptr = seat.create_virtual_device(
                Clutter.InputDeviceType.POINTER_DEVICE
            );
        } catch (e) {
            console.error('E2EInput: virtual devices failed:', e);
            this._kbd = null;
            this._ptr = null;
        }
        // Own the bus name even when device creation failed, so callers can
        // probe capability via Ping() instead of treating absence as a hard
        // failure of every input-dependent check.
        this._ownerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            'com.happytomatoe.E2EInput',
            Gio.BusNameOwnerFlags.NONE,
            (connection) => {
                this._impl = Gio.DBusExportedObject.wrapJSObject(Iface, this);
                this._impl.export(connection, '/com/happytomatoe/E2EInput');
            },
            null,
            null
        );
    }

    disable() {
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = null;
        }
        this._kbd = null;
        this._ptr = null;
    }

    Click(x, y) {
        if (!this._ptr) return;
        let t = Clutter.get_current_event_time() * 1000;
        this._ptr.notify_absolute_motion(t++, x, y);
        this._ptr.notify_button(t++, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        this._ptr.notify_button(t++, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    }

    Move(x, y) {
        // Pointer position without button — wheel scrolling only needs the
        // pointer over the scrolled window; a click can land on row buttons
        // (Remove/Open Editor) and steal keyboard focus from the dialog.
        if (!this._ptr) return;
        this._ptr.notify_absolute_motion(
            Clutter.get_current_event_time() * 1000, x, y);
    }

    Wheel(ticks) {
        if (!this._ptr) return;
        const dir = ticks < 0 ? Clutter.ScrollDirection.UP : Clutter.ScrollDirection.DOWN;
        for (let i = 0; i < Math.abs(ticks); i++) {
            this._ptr.notify_discrete_scroll(
                Clutter.get_current_event_time() * 1000,
                dir,
                Clutter.ScrollSource.WHEEL
            );
        }
    }

    ActivateWindow(title) {
        // Keyboard focus in headless nested sessions never reaches GTK windows
        // on its own — mutter must send wl_keyboard.enter. Raise+activate the
        // MetaWindow so GTK assigns an initial focus widget (Tab/keys then work).
        const actor = global.get_window_actors().find(
            a => (a.meta_window.get_title() || '').includes(title)
        );
        if (!actor) {
            console.error(`E2EInput: no window titled '${title}'`);
            return;
        }
        actor.meta_window.raise();
        actor.meta_window.activate(global.get_current_time());
    }

    _key(keyval) {
        let t = Clutter.get_current_event_time() * 1000;
        this._kbd.notify_keyval(t++, keyval, Clutter.KeyState.PRESSED);
        this._kbd.notify_keyval(t++, keyval, Clutter.KeyState.RELEASED);
    }

    Ping(ignored) {
        return this._kbd ? 'ok' : 'no-keyboard';
    }

    TypeText(text) {
        if (!this._kbd) return;
        for (const ch of text) {
            const kv = Clutter.unicode_to_keysym(ch.codePointAt(0));
            if (kv !== 0) this._key(kv);
        }
    }

    TypeKey(keyvalStr) {
        if (!this._kbd) return;
        // Takes a numeric keysym (e.g. '0xff56' = Page_Down) — GJS Clutter
        // has no keyval_from_name.
        const kv = Number(keyvalStr);
        if (!Number.isFinite(kv) || kv <= 0) {
            console.error(`E2EInput: bad keysym '${keyvalStr}'`);
            return;
        }
        this._key(kv);
    }
}
