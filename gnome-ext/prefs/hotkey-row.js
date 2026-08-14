// @ts-check
/**
 * Hotkey row widget + capture dialog.
 */
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio'; // eslint-disable-line no-unused-vars -- used in JSDoc
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Show the hotkey capture dialog.
 * @param {Gio.Settings} settings
 * @param {Gtk.Window} parentWindow
 * @param {Gtk.Label} label - Label to update with the new hotkey
 */
function showHotkeyDialog(settings, parentWindow, label) {
    const dialog = new Gtk.Window({
        title: _('Set Shortcut'),
        modal: true,
        transient_for: parentWindow,
        default_width: 400,
        default_height: 200,
    });

    const mainBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    dialog.set_child(mainBox);

    const instructionLabel = new Gtk.Label({
        label: _('Press a new shortcut key combination'),
        wrap: true,
        xalign: 0,
    });
    mainBox.append(instructionLabel);

    const keyLabel = new Gtk.Label({
        label: _('New shortcut: None'),
        xalign: 0,
    });
    mainBox.append(keyLabel);

    const cancelButton = new Gtk.Button({
        label: _('Cancel'),
        halign: Gtk.Align.END,
    });
    const setButton = new Gtk.Button({
        label: _('Set'),
        halign: Gtk.Align.END,
        sensitive: false,
    });

    const buttonBox = new Gtk.Box({
        spacing: 6,
        halign: Gtk.Align.END,
    });
    buttonBox.append(cancelButton);
    buttonBox.append(setButton);
    mainBox.append(buttonBox);

    let currentKey = null;

    // Create a key capture controller
    const keyController = new Gtk.EventControllerKey();
    dialog.add_controller(keyController);

    keyController.connect(
        'key-pressed',
        (controller, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            const key = Gdk.keyval_name(keyval);

            if (!key) {
                return false;
            }

            // Ignore modifier-only key presses
            if (
                key === 'Control_L' ||
                key === 'Control_R' ||
                key === 'Shift_L' ||
                key === 'Shift_R' ||
                key === 'Alt_L' ||
                key === 'Alt_R' ||
                key === 'Super_L' ||
                key === 'Super_R'
            ) {
                return false;
            }

            if (!mask) {
                return false;
            }

            const accel = Gtk.accelerator_name(keyval, mask);
            if (accel && accel !== '<Disabled>') {
                currentKey = accel;
                keyLabel.set_label(`New shortcut: ${accel}`);
                setButton.sensitive = true;
            }
            return true;
        }
    );

    cancelButton.connect('clicked', () => {
        dialog.close();
    });

    setButton.connect('clicked', () => {
        if (currentKey) {
            settings.set_strv('hotkey', [currentKey]);
            label.set_label(currentKey);
        }
        dialog.close();
    });

    // Handle escape key
    const escapeController = new Gtk.EventControllerKey();
    dialog.add_controller(escapeController);
    escapeController.connect('key-pressed', (controller, keyval) => {
        if (keyval === Gdk.KEY_Escape) {
            dialog.close();
            return true;
        }
        return false;
    });

    dialog.present();
}

function getHotkeyDisplay(hotkeyValue) {
    try {
        if (hotkeyValue?.trim()) {
            return hotkeyValue;
        }
    } catch (e) {
        console.error('Error parsing hotkey:', e);
    }
    return _('Not set');
}

/**
 * Create the hotkey settings row.
 * @param {Gio.Settings} settings
 * @param {Gtk.Window} parentWindow
 * @returns {Adw.ActionRow}
 */
export function createHotkeyRow(settings, parentWindow) {
    const hotkeyRow = new Adw.ActionRow({
        title: _('Recording Hotkey'),
    });

    const hotkeyBox = new Gtk.Box({
        hexpand: true,
        spacing: 6,
    });
    hotkeyRow.add_suffix(hotkeyBox);

    const hotkeyLabel = new Gtk.Label({
        label: getHotkeyDisplay(settings.get_strv('hotkey')[0]),
        xalign: 0,
    });
    hotkeyBox.append(hotkeyLabel);
    hotkeyLabel.set_hexpand(true);

    const hotkeyButton = new Gtk.Button({
        label: _('Set Shortcut…'),
        halign: Gtk.Align.END,
    });
    hotkeyBox.append(hotkeyButton);

    hotkeyButton.connect('clicked', () => {
        showHotkeyDialog(settings, parentWindow, hotkeyLabel);
    });

    return hotkeyRow;
}
