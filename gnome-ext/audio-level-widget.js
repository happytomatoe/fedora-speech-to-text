import St from 'gi://St';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const NUM_SEGMENTS = 10;
const MARGIN_BOTTOM = 60;
const SMOOTH = 0.6;
const SHOW_DELAY_MS = 300;

export class AudioLevelWidget {
    constructor() {
        this._widget = null;
        this._segments = [];
        this._smoothedLevel = 0;
        this._visible = false;
        this._showTimeoutId = 0;
        this.onCancel = null;  // callback when cancel button clicked
    }
    show() {
        if (this._widget) return;

        // Delay showing the widget to avoid initial audio spikes
        this._showTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SHOW_DELAY_MS,
            () => {
                this._showTimeoutId = 0;
                this._createWidget();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _createWidget() {
        if (this._widget) return;

        this._widget = new St.BoxLayout({
            style_class: 'osd-widget',
            vertical: false,
        });

        const micIcon = new St.Icon({
            icon_name: 'audio-input-microphone-symbolic',
            style_class: 'osd-mic-icon',
        });
        this._widget.add_child(micIcon);

        this._segments = [];
        for (let i = 0; i < NUM_SEGMENTS; i++) {
            const seg = new St.Widget({
                style_class: 'osd-segment idle',
            });
            this._widget.add_child(seg);
            this._segments.push(seg);
        }

        // Cancel button (X icon, ghost circle → red on hover)
        this._cancelButton = new St.Button({
            style_class: 'osd-cancel-button',
            accessible_name: _('Cancel recording'),
            reactive: true,
            track_hover: true,
            can_focus: true,
            x_align: 2,  // CENTER
            y_align: 2,  // CENTER
        });
        this._cancelButton.set_size(36, 36);
        const cancelIcon = new St.Icon({
            icon_name: 'window-close-symbolic',
            style_class: 'osd-cancel-icon',
        });
        this._cancelButton.add_child(cancelIcon);
        this._cancelButton.connect('clicked', () => {
            if (this.onCancel) this.onCancel();
        });
        this._widget.add_child(this._cancelButton);

        Main.layoutManager.addTopChrome(this._widget);
        this._positionWidget();
        this._visible = true;
    }

    hide() {
        // Cancel any pending show timeout
        if (this._showTimeoutId) {
            GLib.source_remove(this._showTimeoutId);
            this._showTimeoutId = 0;
        }

        if (!this._widget) return;

        Main.layoutManager.removeChrome(this._widget);
        this._widget.destroy();
        this._widget = null;
        this._segments = [];
        this._smoothedLevel = 0;
        this._visible = false;
    }

    updateLevel(level) {
        if (!this._widget || !this._visible) return;

        this._smoothedLevel = SMOOTH * this._smoothedLevel + (1 - SMOOTH) * level;

        const activeCount = Math.round(this._smoothedLevel * NUM_SEGMENTS);
        for (let i = 0; i < NUM_SEGMENTS; i++) {
            const seg = this._segments[i];
            const shouldBeActive = i < activeCount;

            // Determine color tier based on absolute segment position
            let targetClass = 'idle';
            if (shouldBeActive) {
                const ratio = i / NUM_SEGMENTS;
                if (ratio < 0.5) {
                    targetClass = 'green';
                } else if (ratio < 0.7) {
                    targetClass = 'yellow';
                } else {
                    targetClass = 'red';
                }
            }

            // Only update if class changed
            let currentClass = 'idle';
            if (seg.has_style_class_name('green')) currentClass = 'green';
            else if (seg.has_style_class_name('yellow')) currentClass = 'yellow';
            else if (seg.has_style_class_name('red')) currentClass = 'red';

            if (targetClass !== currentClass) {
                seg.remove_style_class_name(currentClass);
                seg.add_style_class_name(targetClass);
            }
        }
    }

    _positionWidget() {
        if (!this._widget) return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        const [, widgetWidth] = this._widget.get_preferred_width(-1);
        const [, widgetHeight] = this._widget.get_preferred_height(-1);

        const x = monitor.x + (monitor.width - widgetWidth) / 2;
        const y = monitor.y + monitor.height - widgetHeight - MARGIN_BOTTOM;

        this._widget.set_position(x, y);
    }

    destroy() {
        this.hide();
    }
}
