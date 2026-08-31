import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

function createSpinner(params) {
    // St.SpinnerContent 在 GNOME 48 才加入；46 上既无 SpinnerContent 也无 St.Spinner。
    // 转圈只是装饰，老 Shell 退化为静态图标即可，不影响 E2E 断言。
    if (St.SpinnerContent) {
        const widget = new St.Widget({...params, reactive: false});
        widget.set_content(new St.SpinnerContent());
        return widget;
    }
    if (St.Spinner) {
        return new St.Spinner({reactive: false});
    }
    return new St.Icon({icon_name: 'media-playback-start-symbolic', ...params, reactive: false});
}

export const VoiceIndicator = GObject.registerClass(
    class VoiceIndicator extends PanelMenu.Button { // aislop-ignore-line import/namespace -- GNOME resource:// namespace is runtime-resolved
        _init() {
            super._init(0.0, 'Voice to Text');
            this._destroyed = false;
            this._buildUI();
            this._recording = false;
            this.onStart = null;
            this.onStop = null;
            this.onConfigure = null;

            this.set_accessible_name(_('Voice to Text'));
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
            this._icon.connect('button-press-event', (_, event) => {
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

            this._spinner = createSpinner({
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

            this._buildMenu();
        }

        _buildMenu() {
            // @ts-expect-error
            this.menu.removeAll();

            const prefsItem = new PopupMenu.PopupMenuItem(_('Preferences')); // aislop-ignore-line import/namespace -- GNOME resource:// namespace is runtime-resolved
            // @ts-expect-error
            prefsItem.set_accessible_name('Preferences');
            // @ts-expect-error
            prefsItem.connect('activate', () => {
                this.onConfigure?.();
            });
            // @ts-expect-error
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
