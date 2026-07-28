import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const WIDGET_WIDTH = 300;
const WIDGET_HEIGHT = 12;
const MARGIN_BOTTOM = 60;
const SMOOTH = 0.6;
const SHOW_DELAY_MS = 300;

export class AudioLevelWidget {
    constructor() {
        this._widget = null;
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

        this._widget = new St.DrawingArea({
            width: WIDGET_WIDTH,
            height: WIDGET_HEIGHT,
            style_class: 'audio-level-widget',
        });

        this._widget.connect('repaint', () => this._draw());

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
        this._smoothedLevel = 0;
        this._visible = false;
    }

    updateLevel(level) {
        if (!this._widget || !this._visible) return;

        this._smoothedLevel =
            SMOOTH * this._smoothedLevel + (1 - SMOOTH) * level;
        this._widget.queue_repaint();
    }

    _positionWidget() {
        if (!this._widget) return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        const x = monitor.x + (monitor.width - WIDGET_WIDTH) / 2;
        const y = monitor.y + monitor.height - WIDGET_HEIGHT - MARGIN_BOTTOM;

        this._widget.set_position(x, y);
    }

    _draw() {
        if (!this._widget) return;

        const cr = this._widget.get_context();
        try {
            const level = Math.min(1, Math.max(0, this._smoothedLevel));
            const w = this._widget.width;
            const h = this._widget.height;
            const fillW = level * w;
            const radius = 4;

            // Background
            cr.setSourceRGBA(0.12, 0.12, 0.12, 0.85);
            this._roundedRect(cr, 0, 0, w, h, radius);
            cr.fill();

            // Fill
            if (fillW > 0) {
                if (level < 0.13) {
                    cr.setSourceRGBA(0.4, 0.4, 0.4, 0.9);
                } else if (level < 0.5) {
                    cr.setSourceRGBA(0.2, 0.85, 0.2, 0.9);
                } else if (level < 0.7) {
                    cr.setSourceRGBA(0.95, 0.8, 0.1, 0.9);
                } else {
                    cr.setSourceRGBA(0.95, 0.2, 0.2, 0.9);
                }

                const fillRadius = Math.min(radius, fillW / 2);
                this._roundedRect(cr, 0, 0, fillW, h, fillRadius);
                cr.fill();
            }
        } finally {
            cr.$dispose();
        }
    }

    _roundedRect(cr, x, y, w, h, r) {
        cr.newPath();
        cr.moveTo(x + r, y);
        cr.lineTo(x + w - r, y);
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.lineTo(x + w, y + h - r);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.lineTo(x + r, y + h);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.lineTo(x, y + r);
        cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
        cr.closePath();
    }

    destroy() {
        this.hide();
    }
}
