// @ts-check
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import {
    gettext as _,
    ExtensionPreferences,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {syncFromConfig, syncToConfig} from './prefs/config-sync.js';
import {createHotkeyRow} from './prefs/hotkey-row.js';
import {createDeviceRow} from './prefs/device-row.js';
import {
    createProviderRows,
    createOutputMethodRow,
} from './prefs/provider-row.js';
import {createCustomWordsGroup} from './prefs/custom-words-row.js';

/**
 * Create a bound Adw.SpinRow, add it to `group`, and trigger `onSync` on change.
 */
function makeSpinRow(spec) {
    const {title, subtitle, lower, upper, step, key, settings, group, onSync} =
        spec;
    const adjustment = new Gtk.Adjustment({
        lower,
        upper,
        step_increment: step,
        page_increment: 10,
    });
    const row = new Adw.SpinRow({title, subtitle, adjustment});
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    row.connect('notify::value', () => {
        onSync().catch(e => console.error('VoiceToText: sync failed:', e));
    });
    return row;
}

/**
 * Create a bound Adw.SwitchRow, add it to `group`.
 */
function makeSwitchRow({title, subtitle, key, settings, group}) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

export default class VoiceToTextPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;

        // Add Ctrl+W to close the preferences window via key controller
        const keyController = new Gtk.EventControllerKey();
        keyController.connect(
            'key-pressed',
            (_controller, keyval, _keycode, state) => {
                const mask = state & Gtk.accelerator_get_default_mod_mask();
                if (
                    keyval === Gdk.KEY_w &&
                    mask === Gdk.ModifierType.CONTROL_MASK
                ) {
                    window.close();
                    return true;
                }
                return false;
            }
        );
        window.add_controller(keyController);
        const settings = this.getSettings();

        // Sync state tracking
        const _configSyncFailed = {v: false};

        const _syncAllToConfig = async () => {
            try {
                await syncToConfig(settings);
            } catch (e) {
                console.error('VoiceToText: syncToConfig failed:', e);
                // The drift is surfaced to the user via syncWarningRow below.
                _configSyncFailed.v = true;
            }
        };

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'audio-input-microphone-symbolic',
        });
        window.add(page);

        const recordingGroup = new Adw.PreferencesGroup({
            title: _('Recording Settings'),
            description: _('Configure voice to text recording behavior'),
        });
        page.add(recordingGroup);

        recordingGroup.add(createHotkeyRow(settings, window));

        const {row: deviceRow, populate: populateDevices} =
            createDeviceRow(settings);
        recordingGroup.add(deviceRow);
        populateDevices();

        const {rows: providerRows} = createProviderRows(
            settings,
            _syncAllToConfig
        );
        for (const row of providerRows) {
            recordingGroup.add(row);
        }

        recordingGroup.add(createOutputMethodRow(settings, _syncAllToConfig));

        const addSwitchRow = (title, subtitle, key) =>
            makeSwitchRow({
                title,
                subtitle,
                key,
                settings,
                group: recordingGroup,
            });

        addSwitchRow(
            _('Show Audio Level Widget'),
            _(
                'Display a floating audio level bar at the bottom of the screen during recording'
            ),
            'show-audio-level-widget'
        );

        const addSpinRow = (title, subtitle, lower, upper, step, key) =>
            makeSpinRow({
                title,
                subtitle,
                lower,
                upper,
                step,
                key,
                settings,
                group: recordingGroup,
                onSync: _syncAllToConfig,
            });

        addSpinRow(
            _('Stop Timeout'),
            _(
                'Seconds to wait for recording process to stop before forcing it'
            ),
            1,
            600,
            1,
            'stop-timeout-seconds'
        );
        addSwitchRow(
            _('Inhibit Sleep During Recording'),
            _('Prevent the system from sleeping while recording'),
            'inhibit-sleep'
        );

        addSpinRow(
            _('Decrease Speaker Volume'),
            _(
                'Reduce speaker output volume during recording (0=no change, 100=mute)'
            ),
            0,
            100,
            5,
            'decrease-speaker-volume'
        );

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
            _syncAllToConfig().catch(e =>
                console.error('VoiceToText: sync failed:', e)
            );
        });
        languageRow.add_suffix(languageEntry);
        recordingGroup.add(languageRow);

        // Shown when a config sync previously failed (see _syncAllToConfig).
        const syncWarningRow = new Adw.ActionRow({
            title: _('⚠️ Configuration Drift'),
            subtitle: _(
                'config.yaml has been modified externally. Click Edit Configuration to review.'
            ),
            visible: false,
        });
        recordingGroup.add(syncWarningRow);

        const {group: customWordsGroup, populate: populateCustomWords} =
            createCustomWordsGroup(settings, window, _syncAllToConfig);
        page.add(customWordsGroup);

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
            // Same path as CONFIG_PATH in prefs/config-sync.js.
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

        const _initSync = async () => {
            const {config, drifted} = await syncFromConfig(settings);
            if (config && drifted.length > 0) {
                syncWarningRow.visible = true;
                _configSyncFailed.v = true;
            }
            populateCustomWords();
        };
        _initSync().catch(e =>
            console.error('VoiceToText: initSync failed:', e)
        );
    }
}
