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
        recordingGroup.add(createOutputMethodRow(settings, _syncAllToConfig));

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
