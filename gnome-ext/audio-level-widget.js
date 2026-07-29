import St from 'gi://St';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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

            // Determine color tier based on segment position within active range
            let targetClass = 'idle';
            if (shouldBeActive) {
                const ratio = activeCount > 0 ? i / activeCount : 0;
                if (ratio < 0.5) {
                    targetClass = 'green';
                } else if (ratio < 0.7) {
                    targetClass = 'yellow';
                } else {
                    targetClass = 'red';
                }
            }

            // Only update if class changed
            const currentClass = seg.has_style_class_name('green')
                ? 'green' : seg.has_style_class_name('yellow')
                ? 'yellow' : seg.has_style_class_name('red')
                ? 'red' : 'idle';

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
