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
