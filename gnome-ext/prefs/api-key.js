// @ts-check
/**
 * API key storage in the OS keyring, plus the "Add API Key" dialog.
 */
import Gtk from 'gi://Gtk';
import Secret from 'gi://Secret';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const KEYRING_SERVICE = 'voice-to-text';
const KEYRING_SCHEMA = 'com.happytomatoe.VoiceToText.ApiKey';

/**
 * Built-in providers that authenticate with an API key. Must mirror the
 * keyring usernames and create-key URLs in scripts/store-api-keys.sh.
 */
const API_KEY_PROVIDERS = {
    deepgram: {
        label: 'Deepgram',
        url: 'https://console.deepgram.com/project/default/settings/api-keys',
    },
    voxtral: {
        label: 'Voxtral',
        url: 'https://console.mistral.ai/?profile_dialog=api-keys',
    },
    groq: {
        label: 'Groq',
        url: 'https://console.groq.com/keys',
    },
    elevenlabs: {
        label: 'ElevenLabs',
        url: 'https://elevenlabs.io/app/settings/api-keys',
    },
    '60db': {
        label: '60db',
        url: 'https://app.60db.ai/app/developers',
    },
};

/** @type {Secret.Schema | null} */
let _schema = null;

function getSchema() {
    if (!_schema) {
        _schema = Secret.Schema.new(KEYRING_SCHEMA, Secret.SchemaFlags.NONE, {
            service: Secret.SchemaAttributeType.STRING,
            username: Secret.SchemaAttributeType.STRING,
        });
    }
    return _schema;
}

/** @param {string} providerId */
function keyringAttributes(providerId) {
    return {service: KEYRING_SERVICE, username: providerId};
}

/**
 * Whether the provider needs an API key at all.
 * @param {string | null} providerId
 * @returns {boolean}
 */
export function providerNeedsApiKey(providerId) {
    return Boolean(
        providerId &&
        Object.prototype.hasOwnProperty.call(API_KEY_PROVIDERS, providerId)
    );
}

/**
 * Look up the provider's key in the OS keyring.
 * @param {string} providerId
 * @returns {boolean}
 */
export function hasStoredApiKey(providerId) {
    try {
        const key = Secret.password_lookup_sync(
            getSchema(),
            keyringAttributes(providerId),
            null
        );
        return Boolean(key);
    } catch (e) {
        console.error('VoiceToText: keyring lookup failed:', e.message);
        return false;
    }
}

/**
 * Show the Add API Key dialog.
 * @param {Gtk.Window} parentWindow
 * @param {string} providerId
 * @param {() => void} onSaved - Called after the key is stored.
 */
export function showAddApiKeyDialog(parentWindow, providerId, onSaved) {
    const info = API_KEY_PROVIDERS[providerId];
    if (!info) {
        console.error(`VoiceToText: no API key metadata for '${providerId}'`);
        return;
    }

    const dialog = new Gtk.Window({
        title: _('Add API Key'),
        modal: true,
        transient_for: parentWindow,
        default_width: 420,
    });

    const mainBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 18,
        margin_bottom: 18,
        margin_start: 18,
        margin_end: 18,
    });
    dialog.set_child(mainBox);

    mainBox.append(
        new Gtk.Label({
            label: _('%s needs an API key. Create one here:').replace(
                '%s',
                info.label
            ),
            wrap: true,
            xalign: 0,
        })
    );

    const link = new Gtk.LinkButton({
        uri: info.url,
        label: info.url,
        halign: Gtk.Align.START,
    });
    mainBox.append(link);

    const entry = new Gtk.Entry({
        placeholder_text: _('Paste API key'),
        visibility: false,
        hexpand: true,
        activates_default: true,
    });
    mainBox.append(entry);

    const errorLabel = new Gtk.Label({
        label: '',
        wrap: true,
        xalign: 0,
        visible: false,
    });
    errorLabel.add_css_class('error');
    mainBox.append(errorLabel);

    const buttonBox = new Gtk.Box({
        spacing: 6,
        halign: Gtk.Align.END,
    });
    const cancelButton = new Gtk.Button({label: _('Cancel')});
    const saveButton = new Gtk.Button({
        label: _('Save'),
        css_classes: ['suggested-action'],
        sensitive: false,
    });
    buttonBox.append(cancelButton);
    buttonBox.append(saveButton);
    mainBox.append(buttonBox);

    entry.connect('changed', () => {
        saveButton.sensitive = entry.get_text().trim().length > 0;
        errorLabel.visible = false;
    });

    const save = () => {
        const key = entry.get_text().trim();
        if (!key) return;
        try {
            const stored = Secret.password_store_sync(
                getSchema(),
                keyringAttributes(providerId),
                Secret.COLLECTION_DEFAULT,
                `${info.label} API Key`,
                key,
                null
            );
            if (!stored) throw new Error('keyring rejected the key');
            dialog.close();
            onSaved();
        } catch (e) {
            console.error('VoiceToText: failed to store API key:', e.message);
            errorLabel.label = _('Could not save the API key: %s').replace(
                '%s',
                e.message
            );
            errorLabel.visible = true;
        }
    };

    saveButton.connect('clicked', save);
    entry.connect('activate', () => {
        if (saveButton.sensitive) save();
    });
    cancelButton.connect('clicked', () => dialog.close());

    dialog.present();
    entry.grab_focus();
}
