// @ts-check
/**
 * Provider/mode selector rows with visibility logic.
 */
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio'; // eslint-disable-line no-unused-vars -- used in JSDoc
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    readCustomProviderNames,
    readDisabledProviderNames,
} from './config-sync.js';

/**
 * Built-in provider id → display label. Must mirror the Python registry in
 * src/voice_to_text/providers/__init__.py (_BATCH_PROVIDERS).
 */
const BATCH_PROVIDERS = {
    deepgram: 'Deepgram',
    groq: 'Groq',
    voxtral: 'Voxtral',
    parakeet: 'Parakeet',
    '60db': '60db',
    elevenlabs: 'ElevenLabs',
    moonshine: 'Moonshine',
};

/**
 * Providers that support streaming. Must mirror _STREAMING_PROVIDERS in
 * src/voice_to_text/providers/__init__.py.
 */
const STREAMING_PROVIDER_IDS = ['deepgram', 'voxtral', '60db', 'moonshine'];

/**
 * Fill a ComboBoxText with the given provider ids/labels.
 * @param {Gtk.ComboBoxText} combo
 * @param {Array<[string, string]>} entries id/label pairs
 */
function fillProviderCombo(combo, entries) {
    for (const [id, label] of entries) combo.append(id, label);
}

/**
 * Providers marked `disabled: true` in config.yaml are hidden from every
 * selector, so a stored selection on one of them cannot be shown. Fall back to
 * the first offered provider and write that choice through to GSettings and
 * config.yaml. Any other missing id (unreadable config, unknown provider) is
 * left alone rather than silently rewriting the user's choice.
 * @param {Gtk.ComboBoxText} combo
 * @param {Array<[string, string]>} entries
 * @param {string} current - stored GSettings value
 * @param {Gio.Settings} settings
 * @param {string} settingsKey
 * @param {Set<string>} disabledProviders
 * @param {() => Promise<void>} syncAllToConfig
 */
function selectEnabledProvider(
    combo,
    entries,
    current,
    settings,
    settingsKey,
    disabledProviders,
    syncAllToConfig
) {
    const ids = entries.map(([id]) => id);
    if (ids.includes(current)) {
        combo.set_active_id(current);
        return;
    }
    const fallback = ids[0];
    if (!disabledProviders.has(current) || !fallback) return;
    combo.set_active_id(fallback);
    console.info(`VoiceToText: '${current}' is disabled, using '${fallback}'`);
    settings.set_string(settingsKey, fallback);
    syncAllToConfig().catch(e => console.error('VoiceToText: sync failed:', e));
}

/**
 * Create the provider/mode settings rows.
 * @param {Gio.Settings} settings
 * @param {() => Promise<void>} syncAllToConfig - Function to sync settings to config.yaml
 * @returns {{ rows: Adw.ActionRow[], updateVisibility: () => void }}
 */
export function createProviderRows(settings, syncAllToConfig) {
    // Provider setting (batch mode only)
    const providerRow = new Adw.ActionRow({
        title: _('Transcription Provider'),
    });

    const disabledProviders = new Set(readDisabledProviderNames());
    const batchEntries = Object.entries(BATCH_PROVIDERS).filter(
        ([id]) => !disabledProviders.has(id)
    );

    const providerCombo = new Gtk.ComboBoxText();
    // Custom providers from config.yaml (e.g. type: batch_custom sections) are
    // appended after the built-ins. Their section names are valid
    // transcription.provider values, so selecting one selects that provider.
    const customEntries = readCustomProviderNames()
        .filter(
            name =>
                !Object.prototype.hasOwnProperty.call(BATCH_PROVIDERS, name) &&
                name !== 'template' &&
                !disabledProviders.has(name)
        )
        .map(
            name => /** @type {[string, string]} */ ([name, `${name} (custom)`])
        );
    const providerEntries = [...batchEntries, ...customEntries];
    fillProviderCombo(providerCombo, providerEntries);
    selectEnabledProvider(
        providerCombo,
        providerEntries,
        settings.get_string('provider'),
        settings,
        'provider',
        disabledProviders,
        syncAllToConfig
    );
    providerCombo.connect('changed', () => {
        const activeId = providerCombo.get_active_id();
        if (activeId) {
            settings.set_string('provider', activeId);
            syncAllToConfig().catch(e =>
                console.error('VoiceToText: sync failed:', e)
            );
        }
    });
    providerRow.add_suffix(providerCombo);

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

    // Streaming provider setting (hybrid/streaming modes)
    const streamingProviderRow = new Adw.ActionRow({
        title: _('Streaming Provider'),
        subtitle: _('Provider for real-time streaming during recording'),
    });

    const streamingEntries = batchEntries.filter(([id]) =>
        STREAMING_PROVIDER_IDS.includes(id)
    );
    const streamingProviderCombo = new Gtk.ComboBoxText();
    fillProviderCombo(streamingProviderCombo, streamingEntries);
    selectEnabledProvider(
        streamingProviderCombo,
        streamingEntries,
        settings.get_string('streaming-provider'),
        settings,
        'streaming-provider',
        disabledProviders,
        syncAllToConfig
    );
    streamingProviderCombo.connect('changed', () => {
        const activeId = streamingProviderCombo.get_active_id();
        if (activeId) {
            settings.set_string('streaming-provider', activeId);
            syncAllToConfig().catch(e =>
                console.error('VoiceToText: sync failed:', e)
            );
        }
    });
    streamingProviderRow.add_suffix(streamingProviderCombo);

    // Batch provider setting (hybrid mode only)
    const batchProviderRow = new Adw.ActionRow({
        title: _('Batch Provider'),
        subtitle: _('Provider for final batch transcription after recording'),
    });

    const batchProviderCombo = new Gtk.ComboBoxText();
    fillProviderCombo(batchProviderCombo, providerEntries);
    selectEnabledProvider(
        batchProviderCombo,
        providerEntries,
        settings.get_string('batch-provider'),
        settings,
        'batch-provider',
        disabledProviders,
        syncAllToConfig
    );
    batchProviderCombo.connect('changed', () => {
        const activeId = batchProviderCombo.get_active_id();
        if (activeId) {
            settings.set_string('batch-provider', activeId);
            syncAllToConfig().catch(e =>
                console.error('VoiceToText: sync failed:', e)
            );
        }
    });
    batchProviderRow.add_suffix(batchProviderCombo);

    // Show/hide provider rows based on mode
    const updateProviderVisibility = () => {
        const mode = settings.get_string('mode');
        providerRow.visible = mode === 'batch';
        streamingProviderRow.visible = mode !== 'batch';
        batchProviderRow.visible = mode === 'hybrid';
    };
    updateProviderVisibility();

    modeCombo.connect('changed', () => {
        const activeId = modeCombo.get_active_id();
        if (activeId) {
            settings.set_string('mode', activeId);
            updateProviderVisibility();
            syncAllToConfig().catch(e =>
                console.error('VoiceToText: sync failed:', e)
            );
        }
    });

    return {
        rows: [providerRow, modeRow, streamingProviderRow, batchProviderRow],
        updateVisibility: updateProviderVisibility,
    };
}

/**
 * Create the output method selector row.
 * @param {Gio.Settings} settings
 * @param {() => Promise<void>} syncAllToConfig - Function to sync settings to config.yaml
 * @returns {Adw.ActionRow}
 */
export function createOutputMethodRow(settings, syncAllToConfig) {
    const row = new Adw.ActionRow({
        title: _('Output Method'),
        subtitle: _('How to deliver transcribed text'),
    });

    const combo = new Gtk.ComboBoxText();
    combo.append('mutter-commit', _('Mutter Commit'));
    combo.append('mutter-virtual', _('Mutter Type'));
    combo.append('type', _('Dotool Type'));
    // Migrate legacy output-method values
    const currentMethod = settings.get_string('output-method');
    const validMethods = ['mutter-commit', 'mutter-virtual', 'type'];
    if (!validMethods.includes(currentMethod)) {
        settings.set_string('output-method', 'type');
    }
    combo.set_active_id(settings.get_string('output-method'));
    combo.connect('changed', () => {
        const activeId = combo.get_active_id();
        if (activeId) {
            settings.set_string('output-method', activeId);
            syncAllToConfig().catch(e =>
                console.error('VoiceToText: sync failed:', e)
            );
        }
    });
    row.add_suffix(combo);

    return row;
}
