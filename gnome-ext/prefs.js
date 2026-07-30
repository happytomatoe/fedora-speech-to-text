// @ts-check
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';
import {load as yamlLoad, dump as yamlDump} from './js-yaml.mjs';
import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Config YAML helpers
const CONFIG_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'voice-to-text', 'config.yaml']);

// Mapping: GSettings key → [config.yaml path parts..., value type]
// Types: 'string', 'int', 'double', 'strv'
const CONFIG_SYNC_MAP = {
    'mode': { path: ['transcription', 'mode'], type: 'string' },
    'provider': { path: ['transcription', 'provider'], type: 'string' },
    'language': { path: ['transcription', 'language'], type: 'string' },
    'streaming-provider': { path: ['transcription', 'hybrid', 'streaming_provider'], type: 'string' },
    'batch-provider': { path: ['transcription', 'hybrid', 'batch_provider'], type: 'string' },
    'decrease-speaker-volume': { path: ['audio', 'speaker', 'decrease_volume'], type: 'int' },
    'stop-timeout-seconds': { path: ['engine', 'stop_timeout'], type: 'int' },
    'custom-words': { path: ['postprocess', 'custom_words'], type: 'strv' },
    'custom-words-threshold': { path: ['postprocess', 'custom_words_threshold'], type: 'double' },
};

function readConfigYaml() {
    try {
        const file = Gio.File.new_for_path(CONFIG_PATH);
        const [ok, contents] = file.load_contents(null);
        if (!ok) return null;
        const decoder = new TextDecoder('utf-8');
        return yamlLoad(decoder.decode(contents));
    } catch (e) {
        console.error('VoiceToText: failed to read config.yaml:', e.message);
        return null;
    }
}

function writeConfigYaml(config) {
    const file = Gio.File.new_for_path(CONFIG_PATH);
    const yamlStr = yamlDump(config);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(yamlStr);
    file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

// Get a nested value from an object by path array
function getConfigValue(config, path) {
    let val = config;
    for (const key of path) {
        if (val == null) return undefined;
        val = val[key];
    }
    return val;
}

// Set a nested value in an object by path array
function setConfigValue(config, path, value) {
    let obj = config;
    for (let i = 0; i < path.length - 1; i++) {
        if (obj[path[i]] == null) obj[path[i]] = {};
        obj = obj[path[i]];
    }
    obj[path[path.length - 1]] = value;
}

// Read config.yaml and seed GSettings for any keys that are empty
async function syncFromConfig(settings) {
    const config = await readConfigYaml();
    if (!config) return { config: null, drifted: [] };

    const drifted = [];
    for (const [gkey, { path, type }] of Object.entries(CONFIG_SYNC_MAP)) {
        const cfgVal = getConfigValue(config, path);
        if (cfgVal === undefined || cfgVal === null) continue;

        let gsetVal;
        if (type === 'strv') {
            gsetVal = settings.get_strv(gkey);
            // If GSettings is empty but config has values, seed from config
            if (gsetVal.length === 0 && cfgVal.length > 0) {
                settings.set_strv(gkey, cfgVal);
                gsetVal = cfgVal;
            }
            // Compare sorted arrays
            const gsetStr = gsetVal.slice().sort().join('\n');
            const cfgStr = cfgVal.slice().sort().join('\n');
            if (gsetStr !== cfgStr) drifted.push(gkey);
        } else if (type === 'int') {
            gsetVal = settings.get_int(gkey);
            if (settings.get_user_value(gkey) === null && gsetVal !== cfgVal) {
                settings.set_int(gkey, cfgVal);
                gsetVal = cfgVal;
            }
            if (gsetVal !== cfgVal) drifted.push(gkey);
        } else if (type === 'double') {
            gsetVal = settings.get_double(gkey);
            const defaultVar = settings.get_default_value(gkey);
            const schemaDefault = defaultVar ? defaultVar.get_value() : 0.0;
            if (gsetVal === schemaDefault && cfgVal !== schemaDefault) {
                settings.set_double(gkey, cfgVal);
                gsetVal = cfgVal;
            }
            if (gsetVal !== cfgVal) drifted.push(gkey);
        } else {
            gsetVal = settings.get_string(gkey);
            if (!gsetVal && cfgVal) {
                settings.set_string(gkey, cfgVal);
                gsetVal = cfgVal;
            }
            if (gsetVal !== cfgVal) drifted.push(gkey);
        }
    }
    return { config, drifted };
}

// Write all mapped settings from GSettings to config.yaml
async function syncToConfig(settings) {
    const config = await readConfigYaml() || {};
    for (const [gkey, { path, type }] of Object.entries(CONFIG_SYNC_MAP)) {
        let value;
        if (type === 'strv') value = settings.get_strv(gkey);
        else if (type === 'int') value = settings.get_int(gkey);
        else if (type === 'double') value = settings.get_double(gkey);
        else value = settings.get_string(gkey);
        setConfigValue(config, path, value);
    }
    await writeConfigYaml(config);
}

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
        group.add(syncWarningRow);

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

        // Seed GSettings from config.yaml on load
        const _initSync = async () => {
            const { config, drifted } = await syncFromConfig(settings);
            if (config && drifted.length > 0) {
                syncWarningRow.visible = true;
                _configSyncFailed.v = true;
            }
            _populateCustomWords();
        };
        _initSync().catch(e => console.error('VoiceToText: initSync failed:', e));

        // Custom words for fuzzy correction — list widget
        const customWordsGroup = new Adw.PreferencesGroup({
            title: _('Custom Words'),
            description: _('Words/phrases for fuzzy correction in transcription output'),
        });
        page.add(customWordsGroup);

        const customWordsList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        customWordsGroup.add(customWordsList);

        // Helper to create a word row
        const createWordRow = (word) => {
            const row = new Adw.ActionRow();
            row.title = word;
            const deleteButton = new Gtk.Button({
                icon_name: 'edit-delete-symbolic',
                css_classes: ['flat', 'error'],
                valign: Gtk.Align.CENTER,
            });
            deleteButton.connect('clicked', () => {
                customWordsList.remove(row);
                // eslint-disable-next-line no-use-before-define
                settings.set_strv('custom-words', _getCustomWordsFromList());
                _syncAllToConfig().catch(e => console.error('VoiceToText: sync failed:', e));
            });
            row.add_suffix(deleteButton);
            return row;
        };

        // Collect current words from the list widget
        const _getCustomWordsFromList = () => {
            const words = [];
            let child = customWordsList.get_first_child();
            while (child) {
                if (child instanceof Adw.ActionRow && child !== addWordRow && child.title) {
                    words.push(child.title);
                }
                child = child.get_next_sibling();
            }
            return words;
        };

        // Populate existing words from GSettings
        const _populateCustomWords = () => {
            const customWords = settings.get_strv('custom-words');
            for (const word of customWords) {
                if (word) customWordsList.append(createWordRow(word));
            }
        };
        // populated by _initSync() after config.yaml seeding completes

        // "Add Word…" row at the bottom
        const addWordRow = new Adw.ActionRow({
            activatable: true,
            title: _('Add Word…'),
            subtitle: _('Add a new word or phrase for fuzzy correction'),
            icon_name: 'list-add-symbolic',
        });
        addWordRow.add_css_class('activatable');
        addWordRow.connect('activated', () => {
            const dialog = new Gtk.Window({
                title: _('Add Custom Word'),
                modal: true,
                transient_for: this._window,
                default_width: 400,
                default_height: 150,
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

            mainBox.append(
                new Gtk.Label({
                    label: _('Enter a word or phrase:'),
                    wrap: true,
                    xalign: 0,
                })
            );

            const entry = new Gtk.Entry({
                placeholder_text: _('e.g., R&D, API, machine learning'),
                hexpand: true,
            });
            mainBox.append(entry);

            const buttonBox = new Gtk.Box({
                spacing: 6,
                halign: Gtk.Align.END,
            });
            const cancelButton = new Gtk.Button({ label: _('Cancel') });
            const addButton = new Gtk.Button({
                label: _('Add'),
                css_classes: ['suggested-action'],
            });
            buttonBox.append(cancelButton);
            buttonBox.append(addButton);
            mainBox.append(buttonBox);

            const doAdd = async () => {
                const text = entry.get_text().trim();
                if (text) {
                    // GTK4 Gtk.ListBox has no insert_child_before; remove/re-add to insert before addWordRow
                    customWordsList.remove(addWordRow);
                    customWordsList.append(createWordRow(text));
                    customWordsList.append(addWordRow);
                    settings.set_strv('custom-words', _getCustomWordsFromList());
                    await _syncAllToConfig();
                }
                dialog.close();
            };
            cancelButton.connect('clicked', () => dialog.close());
            addButton.connect('clicked', () => doAdd().catch(e => console.error('VoiceToText: doAdd failed:', e)));
            entry.connect('activate', () => doAdd().catch(e => console.error('VoiceToText: doAdd failed:', e)));

            dialog.present();
        });
        customWordsList.append(addWordRow);

        // Custom words threshold
        const thresholdRow = new Adw.SpinRow({
            title: _('Matching Threshold'),
            subtitle: _('How strict fuzzy matching is (0=exact, 1=any match)'),
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.0,
                upper: 1.0,
                step_increment: 0.1,
                page_increment: 0.25,
            }),
        });
        settings.bind(
            'custom-words-threshold',
            thresholdRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        thresholdRow.connect('notify::value', () => _syncAllToConfig());
        group.add(thresholdRow);

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
