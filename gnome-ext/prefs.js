// @ts-check
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {syncFromConfig, syncToConfig} from './prefs/config-sync.js';
import {createHotkeyRow} from './prefs/hotkey-row.js';
import {createDeviceRow} from './prefs/device-row.js';
import {createProviderRows, createOutputMethodRow} from './prefs/provider-row.js';
import {createCustomWordsGroup, createThresholdRow} from './prefs/custom-words-row.js';

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
            // @ts-expect-error - makeProxyWrapper returns a constructor but types don't reflect this
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
                    return undefined;
                },
                (err) => {
                    deviceRow.subtitle = _('Start the Voice-to-Text service to list microphones');
                    console.error('VoiceToText: ListInputDevices failed:', err?.message || err);
                }
            ).catch(e => console.error('VoiceToText: ListInputDevices unexpected error:', e));
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
            // eslint-disable-next-line no-use-before-define
            _syncAllToConfig().catch(e => console.error('VoiceToText: sync failed:', e));
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
            // eslint-disable-next-line no-use-before-define
            _syncAllToConfig().catch(e => console.error('VoiceToText: sync failed:', e));
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
            // eslint-disable-next-line no-use-before-define
            _syncAllToConfig().catch(e => console.error('VoiceToText: sync failed:', e));
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
            // eslint-disable-next-line no-use-before-define
            _syncAllToConfig().catch(e => console.error('VoiceToText: sync failed:', e));
        });

        // Output method setting
        const outputMethodRow = new Adw.ActionRow({
            title: _('Output Method'),
            subtitle: _('How to deliver transcribed text'),
        });

        const outputMethodCombo = new Gtk.ComboBoxText();
        outputMethodCombo.append('type', _('Type'));
        outputMethodCombo.append('wl-paste', _('Clipboard + Paste'));
        outputMethodCombo.append('mutter-virtual', _('Mutter Virtual Device'));
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
        stopTimeoutRow.connect('notify::value', () => {
            // eslint-disable-next-line no-use-before-define
            _syncAllToConfig().catch(e => console.error('VoiceToText: sync failed:', e));
        });

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
        decreaseVolumeRow.connect('notify::value', () => {
            // eslint-disable-next-line no-use-before-define
            _syncAllToConfig().catch(e => console.error('VoiceToText: sync failed:', e));
        });

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
            // eslint-disable-next-line no-use-before-define
            _syncAllToConfig().catch(e => console.error('VoiceToText: sync failed:', e));
        });
        languageRow.add_suffix(languageEntry);
        group.add(languageRow);

        // Config sync warning (hidden by default)
        const _configSyncFailed = {v: false};
        const syncWarningRow = new Adw.ActionRow({
            title: _('⚠ config.yaml drift detected'),
            subtitle: _('GSettings and config.yaml differ; saved values will overwrite config.yaml'),
            icon_name: 'dialog-warning-symbolic',
            visible: false,
        });
        syncWarningRow.add_css_class('warning');

        // Sync all settings to config.yaml — auto-retry if previous sync failed
        const _syncAllToConfig = async () => {
            const attempts = _configSyncFailed.v ? 2 : 1;
            for (let i = 0; i < attempts; i++) {
                try {
                    await syncToConfig(settings);
                    _configSyncFailed.v = false;
                    syncWarningRow.visible = false;
                    return;
                } catch (e) {
                    if (i === attempts - 1) {
                        console.error(`VoiceToText: config.yaml sync failed: ${e.message}`);
                        _configSyncFailed.v = true;
                        syncWarningRow.visible = true;
                    }
                }
            }
        };

        // Recording Settings Group
        const recordingGroup = new Adw.PreferencesGroup({
            title: _('Recording Settings'),
            description: _('Configure voice to text recording behavior'),
        });
        page.add(recordingGroup);

        // Hotkey setting
        recordingGroup.add(createHotkeyRow(settings, window));

        // Microphone device selector
        const { row: deviceRow, populate: populateDevices } = createDeviceRow(settings);
        recordingGroup.add(deviceRow);
        populateDevices();

        // Provider/mode settings
        const { rows: providerRows } = createProviderRows(settings, _syncAllToConfig);
        for (const row of providerRows) {
            recordingGroup.add(row);
        }

        // Output method
        recordingGroup.add(createOutputMethodRow(settings));

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
        recordingGroup.add(showAudioLevelRow);

        // Stop timeout setting
        const stopTimeoutRow = new Adw.SpinRow({
            title: _('Stop Timeout'),
            subtitle: _(
                'Seconds to wait for recording process to stop before forcing it'
            ),
            adjustment: new GLib.DoubleRange ? new Gtk.Adjustment({
                lower: 1,
                upper: 120,
                step_increment: 1,
                page_increment: 10,
            }) : new Gtk.Adjustment({
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
        recordingGroup.add(stopTimeoutRow);
        stopTimeoutRow.connect('notify::value', () => {
            _syncAllToConfig().catch(e => console.error('VoiceToText: sync failed:', e));
        });

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
        recordingGroup.add(inhibitSleepRow);

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
        recordingGroup.add(decreaseVolumeRow);
        decreaseVolumeRow.connect('notify::value', () => {
            _syncAllToConfig().catch(e => console.error('VoiceToText: sync failed:', e));
        });

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
            _syncAllToConfig().catch(e => console.error('VoiceToText: sync failed:', e));
        });
        languageRow.add_suffix(languageEntry);
        recordingGroup.add(languageRow);

        // Add sync warning to recording group
        recordingGroup.add(syncWarningRow);

        // Custom Words Group
        const { group: customWordsGroup, populate: populateCustomWords } = createCustomWordsGroup(
            settings,
            window,
            _syncAllToConfig
        );
        page.add(customWordsGroup);

        // Add threshold row to recording group
        recordingGroup.add(createThresholdRow(settings, _syncAllToConfig));

        // Configuration Group
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

        // Seed GSettings from config.yaml on load
        const _initSync = async () => {
            const { config, drifted } = await syncFromConfig(settings);
            if (config && drifted.length > 0) {
                syncWarningRow.visible = true;
                _configSyncFailed.v = true;
            }
            populateCustomWords();
        };
        _initSync().catch(e => console.error('VoiceToText: initSync failed:', e));
    }
}
