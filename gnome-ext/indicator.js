import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const VoiceIndicator = GObject.registerClass(
    class VoiceIndicator extends PanelMenu.Button {
        _init() {
            super._init(0.0, 'Voice to Text');
            this._destroyed = false;
            this._buildUI();
            this._recording = false;
            this.onStart = null;
            this.onStop = null;
            this.onConfigure = null;
        }

        _buildUI() {
            this._box = new St.BoxLayout({
                style_class: 'panel-status-menu-box',
            });

            this._icon = new St.Icon({
                icon_name: 'audio-input-microphone-symbolic',
                style_class: 'system-status-icon',
                reactive: true,
            });
            this._icon.connect('button-press-event', (actor, event) => {
                // Right-click opens the menu, left-click toggles recording
                if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                    this.menu.open();
                    return Clutter.EVENT_STOP;
                }
                if (this._recording) {
                    this.onStop?.();
                } else {
                    this.onStart?.();
                }
                return Clutter.EVENT_STOP;
            });
            this._box.add_child(this._icon);

            this._spinner = new St.Spinner({
                style_class: 'system-status-icon',
                visible: false,
            });
            this._box.add_child(this._spinner);

            const spacer1 = new St.Widget({x_expand: true});
            this._box.add_child(spacer1);

            const spacer2 = new St.Widget({x_expand: true});
            this._box.add_child(spacer2);

            this._stopBtn = new St.Button({
                reactive: true,
                can_focus: true,
                track_hover: true,
            });
            this._stopBtn.add_child(
                new St.Icon({
                    icon_name: 'media-playback-stop-symbolic',
                    style_class: 'system-status-icon',
                })
            );
            this._stopBtn.connect('button-press-event', () => {
                this.onStop?.();
                return Clutter.EVENT_STOP;
            });

            this._box.add_child(this._stopBtn);

            this.add_child(this._box);
            this._setIdleUI();

            // Build the right-click menu
            this._buildMenu();
        }

        _buildMenu() {
            // Clear any existing menu items
            this.menu.removeAll();

            // Add Preferences menu item
            const prefsItem = new PopupMenu.PopupMenuItem(_('Preferences'));
            prefsItem.connect('activate', () => {
                this.onConfigure?.();
            });
            this.menu.addMenuItem(prefsItem);
        }

        setRecording(recording) {
            this._recording = recording;
            if (recording) {
                this._setRecordingUI();
            } else {
                this._setIdleUI();
            }
        }

        setProcessing() {
            this._recording = false;
            this._icon.visible = false;
            this._spinner.visible = true;
            this._stopBtn.visible = false;
        }

        setRecordingActive() {
            this._recording = true;
            this._setRecordingUI();
        }

        _setIdleUI() {
            this._icon.visible = true;
            this._spinner.visible = false;
            this._stopBtn.visible = false;
        }

        _setRecordingUI() {
            this._icon.visible = false;
            this._spinner.visible = false;
            this._stopBtn.visible = true;
        }

        destroy() {
            this._destroyed = true;
            super.destroy();
        }
    }
);
