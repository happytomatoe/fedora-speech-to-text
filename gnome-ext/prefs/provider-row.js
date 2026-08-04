// @ts-check
/**
 * Provider/mode selector rows with visibility logic.
 */
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio'; // eslint-disable-line no-unused-vars -- used in JSDoc
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

    const providerCombo = new Gtk.ComboBoxText();
    providerCombo.append('deepgram', 'Deepgram');
    providerCombo.append('groq', 'Groq');
    providerCombo.append('voxtral', 'Voxtral');
    providerCombo.append('parakeet', 'Parakeet');
    providerCombo.append('60db', '60db');
    providerCombo.append('elevenlabs', 'ElevenLabs');
    providerCombo.set_active_id(settings.get_string('provider'));
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

    const streamingProviderCombo = new Gtk.ComboBoxText();
    streamingProviderCombo.append('deepgram', 'Deepgram');
    streamingProviderCombo.append('voxtral', 'Voxtral');
    streamingProviderCombo.append('60db', '60db');
    streamingProviderCombo.set_active_id(
        settings.get_string('streaming-provider')
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
    batchProviderCombo.append('deepgram', 'Deepgram');
    batchProviderCombo.append('groq', 'Groq');
    batchProviderCombo.append('voxtral', 'Voxtral');
    batchProviderCombo.append('parakeet', 'Parakeet');
    batchProviderCombo.append('60db', '60db');
    batchProviderCombo.append('elevenlabs', 'ElevenLabs');
    batchProviderCombo.set_active_id(settings.get_string('batch-provider'));
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
