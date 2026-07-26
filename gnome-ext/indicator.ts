import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const METER_WIDTH = 50;
const METER_HEIGHT = 6;
const SMOOTH = 0.6;

export const VoiceIndicator = GObject.registerClass(
    class VoiceIndicator extends PanelMenu.Button {
        _destroyed: boolean;
        _smoothedLevel: number;
        _recording: boolean;
        _box!: InstanceType<typeof St.BoxLayout>;
        _icon!: InstanceType<typeof St.Icon>;
        _spinner!: InstanceType<typeof St.Widget>;
        _meter!: InstanceType<typeof St.DrawingArea>;
        _stopBtn!: InstanceType<typeof St.Button>;

        onStart: (() => void) | null;
        onStop: (() => void) | null;
        onConfigure: (() => void) | null;

        _init() {
            super._init(0.0, 'Voice to Text');
            this._destroyed = false;
            this._smoothedLevel = 0;
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
            this._icon.connect('button-press-event', (actor: unknown, event: any) => {
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

            this._spinner = new St.Widget({
                style_class: 'system-status-icon',
                visible: false,
            });
            this._spinner.set_content(new St.SpinnerContent());
            this._box.add_child(this._spinner);

            const spacer1 = new St.Widget({x_expand: true});
            this._box.add_child(spacer1);

            this._meter = new St.DrawingArea({
                width: METER_WIDTH,
                height: METER_HEIGHT,
                x_expand: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._meter.connect('repaint', () => this._drawMeter());
            this._box.add_child(this._meter);

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
            (this.menu as any).removeAll();

            // Add Preferences menu item
            const prefsItem = new PopupMenu.PopupMenuItem(_('Preferences'));
            prefsItem.connect('activate', () => {
                this.onConfigure?.();
            });
            (this.menu as any).addMenuItem(prefsItem);
        }

        setRecording(recording: boolean) {
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
            this._meter.visible = false;
            this._stopBtn.visible = false;
            this._smoothedLevel = 0;
            this._meter.queue_repaint();
        }

        setRecordingActive() {
            this._recording = true;
            this._setRecordingUI();
        }

        _setIdleUI() {
            this._icon.visible = true;
            this._spinner.visible = false;
            this._meter.visible = false;
            this._stopBtn.visible = false;
            this._smoothedLevel = 0;
            this._meter.queue_repaint();
        }

        _setRecordingUI() {
            this._icon.visible = false;
            this._spinner.visible = false;
            this._meter.visible = true;
            this._stopBtn.visible = true;
            this._meter.queue_repaint();
        }

        updateLevel(level: number) {
            if (this._destroyed) return;
            this._smoothedLevel =
                SMOOTH * this._smoothedLevel + (1 - SMOOTH) * level;
            this._meter.queue_repaint();
        }

        _drawMeter() {
            if (this._destroyed) return;
            const cr = this._meter.get_context();
            try {
                const level = Math.min(1, Math.max(0, this._smoothedLevel));
                const w = this._meter.width;
                const h = this._meter.height;
                const fillW = level * w;

                cr.setLineWidth(1);
                cr.setLineJoin(1);

                // Background
                const radius = 2;
                cr.moveTo(radius, 0);
                cr.lineTo(w - radius, 0);
                cr.arc(w - radius, radius, radius, -Math.PI / 2, 0);
                cr.lineTo(w, h - radius);
                cr.arc(w - radius, h - radius, radius, 0, Math.PI / 2);
                cr.lineTo(radius, h);
                cr.arc(radius, h - radius, radius, Math.PI / 2, Math.PI);
                cr.lineTo(0, radius);
                cr.arc(radius, radius, radius, Math.PI, Math.PI * 1.5);
                cr.closePath();

                cr.setSourceRGBA(0.5, 0.5, 0.5, 0.3);
                cr.fill();

                // Fill
                if (fillW > 0) {
                    cr.moveTo(radius, 0);
                    cr.lineTo(fillW > w - radius ? w - radius : fillW, 0);
                    if (fillW > w - radius) {
                        cr.arc(w - radius, radius, radius, -Math.PI / 2, 0);
                        cr.lineTo(w, h - radius);
                        cr.arc(w - radius, h - radius, radius, 0, Math.PI / 2);
                    } else {
                        cr.lineTo(fillW, h);
                    }
                    cr.lineTo(radius, h);
                    cr.arc(radius, h - radius, radius, Math.PI / 2, Math.PI);
                    cr.lineTo(0, radius);
                    cr.arc(radius, radius, radius, Math.PI, Math.PI * 1.5);
                    cr.closePath();

                    if (level < 0.13) {
                        cr.setSourceRGBA(0.4, 0.4, 0.4, 0.7);
                    } else if (level < 0.5) {
                        cr.setSourceRGBA(0.2, 0.85, 0.2, 0.9);
                    } else if (level < 0.7) {
                        cr.setSourceRGBA(0.95, 0.8, 0.1, 0.9);
                    } else {
                        cr.setSourceRGBA(0.95, 0.2, 0.2, 0.9);
                    }
                    cr.fill();
                }
            } finally {
                (cr as any).$dispose();
            }
        }

        destroy() {
            this._destroyed = true;
            super.destroy();
        }
    }
);
