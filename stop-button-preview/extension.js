import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const NUM_SEGMENTS = 10;

const BUTTON_STYLES = [
    {name: '1. Circle Solid', css: 'background-color:#e74c3c;border-radius:999px;min-width:32px;min-height:32px;'},
    {name: '2. Circle Soft', css: 'background-color:rgba(231,76,60,0.85);border-radius:999px;min-width:32px;min-height:32px;'},
    {name: '3. Circle Dark', css: 'background-color:#c0392b;border-radius:999px;min-width:32px;min-height:32px;'},
    {name: '4. Circle Gradient', css: 'background-color:#e74c3c;border-radius:999px;min-width:32px;min-height:32px;'},
    {name: '5. Circle Outline', css: 'background-color:transparent;border:2px solid #e74c3c;border-radius:999px;min-width:32px;min-height:32px;'},
    {name: '6. Circle Thin', css: 'background-color:transparent;border:1.5px solid #e74c3c;border-radius:999px;min-width:32px;min-height:32px;'},
    {name: '7. Circle Inset', css: 'background-color:#c0392b;border-radius:999px;min-width:32px;min-height:32px;'},
    {name: '8. Square Sharp', css: 'background-color:#e74c3c;min-width:30px;min-height:30px;'},
    {name: '9. Square Rounded', css: 'background-color:#e74c3c;border-radius:6px;min-width:30px;min-height:30px;'},
    {name: '10. Square More Round', css: 'background-color:#e74c3c;border-radius:10px;min-width:30px;min-height:30px;'},
    {name: '11. Square Outline', css: 'background-color:transparent;border:2px solid #e74c3c;border-radius:8px;min-width:30px;min-height:30px;'},
    {name: '12. Square Large', css: 'background-color:#e74c3c;border-radius:8px;min-width:36px;min-height:36px;'},
    {name: '13. Square Small', css: 'background-color:#e74c3c;border-radius:6px;min-width:24px;min-height:24px;'},
    {name: '14. Pill Wide', css: 'background-color:#e74c3c;border-radius:999px;min-width:40px;min-height:28px;'},
    {name: '15. Pill Capsule', css: 'background-color:#e74c3c;border-radius:999px;min-width:36px;min-height:24px;'},
    {name: '16. Pill Outline', css: 'background-color:transparent;border:2px solid #e74c3c;border-radius:999px;min-width:32px;min-height:32px;'},
    {name: '17. Pill Soft', css: 'background-color:rgba(231,76,60,0.7);border-radius:999px;min-width:32px;min-height:32px;'},
    {name: '18. Pill Dark', css: 'background-color:#7b241c;border-radius:999px;min-width:32px;min-height:32px;'},
    {name: '19. Neon', css: 'background-color:#0a0a0a;border:2px solid #ff0040;border-radius:999px;min-width:32px;min-height:32px;'},
    {name: '20. Glass', css: 'background-color:rgba(231,76,60,0.3);border:1px solid rgba(231,76,60,0.5);border-radius:12px;min-width:32px;min-height:32px;'},
    {name: '21. Ring', css: 'background-color:#1a1a1a;border:2px solid #e74c3c;border-radius:999px;min-width:32px;min-height:32px;'},
    {name: '22. Stop Sign', css: 'background-color:#e74c3c;border-radius:4px;min-width:32px;min-height:32px;'},
    {name: '23. Current Default', css: 'background-color:rgba(245,66,66,0.85);border-radius:999px;min-width:32px;min-height:32px;'},
];

export default class StopButtonPreviewExtension extends Extension {
    enable() {
        // The floating widget — mic + 10 segments + stop button
        this._widget = new St.BoxLayout({
            vertical: false,
            style_class: 'osd-widget',
            reactive: true,
        });

        // Mic icon
        this._widget.add_child(new St.Icon({
            icon_name: 'audio-input-microphone-symbolic',
            style_class: 'osd-mic-icon',
        }));

        // 10 audio segments
        for (let i = 0; i < NUM_SEGMENTS; i++) {
            this._widget.add_child(new St.Widget({
                style_class: i < 5 ? 'osd-segment green' : 'osd-segment idle',
            }));
        }

        // Stop button — default style
        this._stopBtn = new St.Button({
            reactive: true,
            can_focus: true,
            track_hover: true,
            style: BUTTON_STYLES[22].css,
        });
        this._stopBtn.add_child(new St.Icon({
            icon_name: 'window-close-symbolic',
            style: 'color:white;icon-size:14px;',
        }));
        this._widget.add_child(this._stopBtn);

        // Add widget as top chrome (same as real extension)
        Main.layoutManager.addTopChrome(this._widget);

        // Position at bottom center
        this._positionWidget();

        // Panel button with dropdown
        this._indicator = new PanelMenu.Button(0.0, 'Stop Button Preview', false);
        this._indicator.add_child(new St.Icon({
            icon_name: 'preferences-other-symbolic',
            style_class: 'system-status-icon',
        }));

        // Add style options to dropdown — menu scrolls automatically
        for (const style of BUTTON_STYLES) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: true});
            const label = new St.Label({
                text: style.name,
                style: 'font-size:12px;',
                x_expand: true,
            });
            item.add_child(label);

            // Hover → preview the style
            item.connect('enter-event', () => {
                this._stopBtn.set_style(style.css);
            });

            // Click → keep the style
            item.connect('activate', () => {
                this._stopBtn.set_style(style.css);
                log(`[StopButtonPreview] Applied: ${style.name}`);
            });

            this._indicator.menu.addMenuItem(item);
        }

        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    _positionWidget() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        const [, widgetWidth] = this._widget.get_preferred_width(-1);
        const [, widgetHeight] = this._widget.get_preferred_height(-1);

        this._widget.set_position(
            monitor.x + (monitor.width - widgetWidth) / 2,
            monitor.y + monitor.height - widgetHeight - 60
        );
    }

    disable() {
        if (this._widget) {
            Main.layoutManager.removeChrome(this._widget);
            this._widget.destroy();
            this._widget = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
    }
}
