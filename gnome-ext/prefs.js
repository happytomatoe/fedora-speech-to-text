import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';
import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class VoiceToTextPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        const settings = this.getSettings();

        // Create a preferences page
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'audio-input-microphone-symbolic',
        });
        window.add(page);

        // Create a preferences group
        const group = new Adw.PreferencesGroup({
            title: _('Recording Settings'),
            description: _('Configure voice to text recording behavior'),
        });
        page.add(group);

        // Hotkey setting - using a custom row with key capture
        const hotkeyRow = new Adw.ActionRow({
            title: _('Recording Hotkey'),
        });

        const hotkeyBox = new Gtk.Box({
            hexpand: true,
            spacing: 6,
        });
        hotkeyRow.add_suffix(hotkeyBox);

        const hotkeyLabel = new Gtk.Label({
            label: this._getHotkeyDisplay(settings.get_strv('hotkey')[0]),
            xalign: 0,
        });
        hotkeyBox.append(hotkeyLabel);
        hotkeyLabel.set_hexpand(true);

        const hotkeyButton = new Gtk.Button({
            label: _('Set Shortcut…'),
            halign: Gtk.Align.END,
        });
        hotkeyBox.append(hotkeyButton);

        // Create a key capture dialog
        hotkeyButton.connect('clicked', () => {
            this._showHotkeyDialog(settings, hotkeyLabel);
        });

        group.add(hotkeyRow);

        // Microphone input device setting
        const deviceRow = new Adw.ActionRow({
            title: _('Microphone'),
            subtitle: _('Audio input device used for recording'),
        });

        const deviceCombo = new Gtk.ComboBoxText();
        deviceCombo.append('__system_default__', _('System default'));
        deviceRow.add_suffix(deviceCombo);
        group.add(deviceRow);

        // Populate the device list from the D-Bus service (ListInputDevices).
        const DeviceListIface = `
<node>
  <interface name="com.happytomatoe.VoiceToText">
    <method name="ListInputDevices">
      <arg type="a(ss)" name="devices" direction="out"/>
    </method>
  </interface>
</node>`;
        const DeviceListProxy = Gio.DBusProxy.makeProxyWrapper(DeviceListIface);
        let deviceProxy = null;
        try {
            deviceProxy = new DeviceListProxy(
                Gio.DBus.session,
                'com.happytomatoe.VoiceToText',
                '/com/happytomatoe/VoiceToText'
            );
        } catch (e) {
            console.error('VoiceToText: failed to create device list proxy:', e.message);
        }

        const currentDevice = settings.get_string('input-device') || '__system_default__';
        deviceCombo.set_active_id(currentDevice);

        const populateDevices = () => {
            if (!deviceProxy) {
                deviceRow.subtitle = _('Voice-to-Text service not available');
                return;
            }
            deviceProxy.ListInputDevicesAsync().then(
                (devices) => {
                    deviceCombo.remove_all();
                    deviceCombo.append('__system_default__', _('System default'));
                    for (const [id, label] of devices) {
                        if (id === '__system_default__') continue;
                        deviceCombo.append(id, label);
                    }
                    const active = settings.get_string('input-device') || '__system_default__';
                    if (deviceCombo.get_active_id() !== active) {
                        deviceCombo.set_active_id(active);
                    }
                    deviceRow.subtitle = _('Audio input device used for recording');
                },
                (err) => {
                    deviceRow.subtitle = _('Start the Voice-to-Text service to list microphones');
                    console.error('VoiceToText: ListInputDevices failed:', err?.message || err);
                }
            );
        };
        populateDevices();

        deviceCombo.connect('changed', () => {
            const id = deviceCombo.get_active_id();
            if (id) {
                settings.set_string('input-device', id);
            }
        });

        // Provider setting (batch mode only)
        const providerRow = new Adw.ActionRow({
            title: _('Transcription Provider'),
        });

        const providerCombo = new Gtk.ComboBoxText();
        providerCombo.append('deepgram', 'Deepgram');
        providerCombo.append('groq', 'Groq');
        providerCombo.append('voxtral', 'Voxtral');
        providerCombo.append('parakeet', 'Parakeet');
        providerCombo.append('60db', '60db');
        providerCombo.append('elevenlabs', 'ElevenLabs');
        providerCombo.set_active_id(settings.get_string('provider'));
        providerCombo.connect('changed', () => {
            settings.set_string('provider', providerCombo.get_active_id());
        });
        providerRow.add_suffix(providerCombo);
        group.add(providerRow);

        // Transcription mode setting
        const modeRow = new Adw.ActionRow({
            title: _('Transcription Mode'),
            subtitle: _(
                'Batch: single-pass; Hybrid: streaming + batch; Streaming: streaming only'
            ),
        });

        const modeCombo = new Gtk.ComboBoxText();
        modeCombo.append('batch', _('Batch'));
        modeCombo.append('hybrid', _('Hybrid (Streaming + Batch)'));
        modeCombo.append('streaming', _('Streaming'));
        modeCombo.set_active_id(settings.get_string('mode'));
        modeRow.add_suffix(modeCombo);
        group.add(modeRow);

        // Streaming provider setting (hybrid/streaming modes)
        const streamingProviderRow = new Adw.ActionRow({
            title: _('Streaming Provider'),
            subtitle: _('Provider for real-time streaming during recording'),
        });

        const streamingProviderCombo = new Gtk.ComboBoxText();
        streamingProviderCombo.append('deepgram', 'Deepgram');
        streamingProviderCombo.append('voxtral', 'Voxtral');
        streamingProviderCombo.append('60db', '60db');
        streamingProviderCombo.set_active_id(
            settings.get_string('streaming-provider')
        );
        streamingProviderCombo.connect('changed', () => {
            settings.set_string(
                'streaming-provider',
                streamingProviderCombo.get_active_id()
            );
        });
        streamingProviderRow.add_suffix(streamingProviderCombo);
        group.add(streamingProviderRow);

        // Batch provider setting (hybrid mode only)
        const batchProviderRow = new Adw.ActionRow({
            title: _('Batch Provider'),
            subtitle: _(
                'Provider for final batch transcription after recording'
            ),
        });

        const batchProviderCombo = new Gtk.ComboBoxText();
        batchProviderCombo.append('deepgram', 'Deepgram');
        batchProviderCombo.append('groq', 'Groq');
        batchProviderCombo.append('voxtral', 'Voxtral');
        batchProviderCombo.append('parakeet', 'Parakeet');
        batchProviderCombo.append('60db', '60db');
        batchProviderCombo.append('elevenlabs', 'ElevenLabs');
        batchProviderCombo.set_active_id(settings.get_string('batch-provider'));
        batchProviderCombo.connect('changed', () => {
            settings.set_string(
                'batch-provider',
                batchProviderCombo.get_active_id()
            );
        });
        batchProviderRow.add_suffix(batchProviderCombo);
        group.add(batchProviderRow);

        // Show/hide provider rows based on mode
        const updateProviderVisibility = () => {
            const mode = settings.get_string('mode');
            providerRow.visible = mode === 'batch';
            streamingProviderRow.visible = mode !== 'batch';
            batchProviderRow.visible = mode === 'hybrid';
        };
        updateProviderVisibility();

        modeCombo.connect('changed', () => {
            settings.set_string('mode', modeCombo.get_active_id());
            updateProviderVisibility();
        });

        // Output method setting
        const outputMethodRow = new Adw.ActionRow({
            title: _('Output Method'),
            subtitle: _('How to deliver transcribed text'),
        });

        const outputMethodCombo = new Gtk.ComboBoxText();
        outputMethodCombo.append('type', _('Type'));
        outputMethodCombo.append('clipboard', _('Clipboard'));
        outputMethodCombo.set_active_id(settings.get_string('output-method'));
        outputMethodCombo.connect('changed', () => {
            settings.set_string(
                'output-method',
                outputMethodCombo.get_active_id()
            );
        });
        outputMethodRow.add_suffix(outputMethodCombo);
        group.add(outputMethodRow);

        // Show floating audio level widget toggle
        const showAudioLevelRow = new Adw.SwitchRow({
            title: _('Show Audio Level Widget'),
            subtitle: _('Display a floating audio level bar at the bottom of the screen during recording'),
        });
        settings.bind(
            'show-audio-level-widget',
            showAudioLevelRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(showAudioLevelRow);

        // Stop timeout setting
        const stopTimeoutRow = new Adw.SpinRow({
            title: _('Stop Timeout'),
            subtitle: _(
                'Seconds to wait for recording process to stop before forcing it'
            ),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 120,
                step_increment: 1,
                page_increment: 10,
            }),
        });
        settings.bind(
            'stop-timeout-seconds',
            stopTimeoutRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(stopTimeoutRow);

        // Inhibit sleep during recording
        const inhibitSleepRow = new Adw.SwitchRow({
            title: _('Inhibit Sleep During Recording'),
            subtitle: _('Prevent the system from sleeping while recording'),
        });
        settings.bind(
            'inhibit-sleep',
            inhibitSleepRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(inhibitSleepRow);

        // Decrease speaker volume during recording
        const decreaseVolumeRow = new Adw.SpinRow({
            title: _('Decrease Speaker Volume'),
            subtitle: _(
                'Reduce speaker output volume during recording (0=no change, 100=mute)'
            ),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 5,
                page_increment: 10,
            }),
        });
        settings.bind(
            'decrease-speaker-volume',
            decreaseVolumeRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(decreaseVolumeRow);

        // Language setting
        const languageRow = new Adw.ActionRow({
            title: _('Language'),
            subtitle: _('Language code (e.g., en, es, fr)'),
        });

        const languageEntry = new Gtk.Entry({
            text: settings.get_string('language'),
            width_chars: 6,
        });
        languageEntry.connect('changed', () => {
            settings.set_string('language', languageEntry.get_text());
        });
        languageRow.add_suffix(languageEntry);
        group.add(languageRow);

        // Configuration group
        const configGroup = new Adw.PreferencesGroup({
            title: _('Configuration'),
            description: _('Advanced settings stored in config.yaml'),
        });
        page.add(configGroup);

        const editConfigRow = new Adw.ActionRow({
            title: _('Edit Configuration File'),
            subtitle: _('Open config.yaml in your default editor ($EDITOR)'),
        });
        configGroup.add(editConfigRow);

        const editConfigButton = new Gtk.Button({
            label: _('Open Editor'),
            halign: Gtk.Align.END,
        });
        editConfigRow.add_suffix(editConfigButton);

        editConfigButton.connect('clicked', () => {
            const configPath = `${GLib.get_home_dir()}/.config/voice-to-text/config.yaml`;
            try {
                const launcher = new Gio.SubprocessLauncher({
                    flags: Gio.SubprocessFlags.NONE,
                });
                launcher.spawnv(['xdg-open', configPath]);
            } catch (e) {
                console.error('VoiceToText: failed to open editor:', e.message);
            }
        });
    }

    _getHotkeyDisplay(hotkeyValue) {
        try {
            if (hotkeyValue && hotkeyValue.trim()) {
                return hotkeyValue;
            }
        } catch (e) {
            console.error('Error parsing hotkey:', e);
        }
        return _('Not set');
    }

    _showHotkeyDialog(settings, label) {
        const dialog = new Gtk.Window({
            title: _('Set Shortcut'),
            modal: true,
            transient_for: this._window,
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
}
