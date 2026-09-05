// @ts-check
/**
 * Config YAML ↔ GSettings synchronization.
 *
 * Pure utility functions
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {load as yamlLoad, dump as yamlDump} from '../vendor/js-yaml.mjs';

const CONFIG_PATH = GLib.build_filenamev([
    GLib.get_home_dir(),
    '.config',
    'voice-to-text',
    'config.yaml',
]);

// Mapping: GSettings key → [config.yaml path parts..., value type]
// Types: 'string', 'int', 'double', 'strv'
const CONFIG_SYNC_MAP = {
    mode: {path: ['transcription', 'mode'], type: 'string'},
    provider: {path: ['transcription', 'provider'], type: 'string'},
    language: {path: ['transcription', 'language'], type: 'string'},
    'streaming-provider': {
        path: ['transcription', 'hybrid', 'streaming_provider'],
        type: 'string',
    },
    'batch-provider': {
        path: ['transcription', 'hybrid', 'batch_provider'],
        type: 'string',
    },
    'decrease-speaker-volume': {
        path: ['audio', 'speaker', 'decrease_volume'],
        type: 'int',
    },
    'stop-timeout-seconds': {path: ['engine', 'stop_timeout'], type: 'int'},
    'custom-words': {path: ['postprocess', 'custom_words'], type: 'strv'},
    'output-method': {
        path: ['engine', 'output_method'],
        type: 'string',
    },
    profiling: {path: ['profiling'], type: 'boolean'},
};

function readConfigYaml() {
    const file = Gio.File.new_for_path(CONFIG_PATH);
    if (!file.query_exists(null)) return {};
    try {
        const [ok, contents] = file.load_contents(null);
        if (!ok) return null;
        const decoder = new TextDecoder('utf-8');
        return yamlLoad(decoder.decode(contents)) ?? {};
    } catch (e) {
        console.error('VoiceToText: failed to read config.yaml:', e.message);
        return null;
    }
}

/**
 * Names of user-defined provider sections in config.yaml with
 * `type: template`. These are valid transcription.provider values and are
 * shown as "name (custom)" entries.
 * @returns {string[]}
 */
export function readCustomProviderNames() {
    const config = readConfigYaml();
    if (!config) return [];
    return Object.entries(config)
        .filter(
            ([key, value]) =>
                value !== null &&
                typeof value === 'object' &&
                !Array.isArray(value) &&
                value.type === 'template'
        )
        .map(([key]) => key);
}

function writeConfigYaml(config) {
    const file = Gio.File.new_for_path(CONFIG_PATH);
    const parent = file.get_parent();
    if (parent && !parent.query_exists(null)) {
        parent.make_directory_with_parents(null);
    }
    const yamlStr = yamlDump(config);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(yamlStr);
    // REPLACE_DESTINATION recreates the file with default (world-readable)
    // perms — config can hold API keys, so preserve the existing mode (or
    // default to 0600 for a fresh file) after the replace.
    let mode = 0o600;
    try {
        const info = file.query_info(
            Gio.FILE_ATTRIBUTE_UNIX_MODE,
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        const m = info.get_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE);
        // Strip group/other bits: config may hold API keys, never world-readable.
        if (m) mode = m & 0o600;
    } catch (e) {
        // File doesn't exist yet — keep the 0600 default.
    }
    const [ok] = file.replace_contents(
        bytes,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
    if (!ok) {
        console.error('VoiceToText: failed to write config.yaml');
        return;
    }
    try {
        file.set_attribute_uint32(
            Gio.FILE_ATTRIBUTE_UNIX_MODE,
            mode,
            Gio.FileQueryInfoFlags.NONE,
            null
        );
    } catch (e) {
        console.error(
            'VoiceToText: failed to restore config.yaml mode:',
            e.message
        );
    }
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

// Type-check a config value against the declared sync type.
function typeMatches(type, val) {
    switch (type) {
        case 'int':
            return Number.isInteger(val);
        case 'double':
            return typeof val === 'number';
        case 'string':
            return typeof val === 'string';
        case 'strv':
            return Array.isArray(val);
        case 'boolean':
            return typeof val === 'boolean';
        default:
            return false;
    }
}

/**
 * Read config.yaml and seed GSettings for any keys that are empty.
 * @param {Gio.Settings} settings
 * @returns {{config: object|null, drifted: string[]}}
 */
export function syncFromConfig(settings) {
    const config = readConfigYaml();
    if (!config) return {config: null, drifted: []};

    const drifted = [];
    for (const [gkey, {path, type}] of Object.entries(CONFIG_SYNC_MAP)) {
        const cfgVal = getConfigValue(config, path);
        if (cfgVal === undefined || cfgVal === null) continue;

        if (!typeMatches(type, cfgVal)) {
            console.warn(
                `VoiceToText: skipping ${gkey}: expected ${type}, got ${typeof cfgVal}`
            );
            continue;
        }

        if (syncSetting(settings, gkey, type, cfgVal)) {
            drifted.push(gkey);
        }
    }
    return {config, drifted};
}

// Seed GSettings from a config value when no user value exists; report drift.
// Returns true if the current GSettings value differs from the config value.
function syncSetting(settings, gkey, type, cfgVal) {
    let gsetVal;
    if (type === 'strv') {
        gsetVal = settings.get_strv(gkey);
        // Only seed from config if GSettings has no user value (not explicitly set)
        if (
            settings.get_user_value(gkey) === null &&
            gsetVal.length === 0 &&
            cfgVal.length > 0
        ) {
            settings.set_strv(gkey, cfgVal);
            gsetVal = cfgVal;
        }
        // Compare sorted arrays
        const gsetStr = gsetVal.slice().sort().join('\n');
        const cfgStr = cfgVal.slice().sort().join('\n');
        return gsetStr !== cfgStr;
    }

    if (type === 'int') {
        gsetVal = settings.get_int(gkey);
    } else if (type === 'double') {
        gsetVal = settings.get_double(gkey);
    } else if (type === 'boolean') {
        gsetVal = settings.get_boolean(gkey);
    } else {
        gsetVal = settings.get_string(gkey);
    }

    if (settings.get_user_value(gkey) === null && gsetVal !== cfgVal) {
        if (type === 'int') settings.set_int(gkey, cfgVal);
        else if (type === 'double') settings.set_double(gkey, cfgVal);
        else if (type === 'boolean') settings.set_boolean(gkey, cfgVal);
        else settings.set_string(gkey, cfgVal);
        gsetVal = cfgVal;
    }
    return gsetVal !== cfgVal;
}

/**
 * Write all mapped settings from GSettings to config.yaml.
 * @param {Gio.Settings} settings
 */
export function syncToConfig(settings) {
    const config = readConfigYaml();
    if (!config) {
        console.error(
            'VoiceToText: syncToConfig failed - cannot read config.yaml'
        );
        throw new Error('Failed to read config.yaml for sync');
    }
    for (const [gkey, {path, type}] of Object.entries(CONFIG_SYNC_MAP)) {
        let value;
        if (type === 'strv') value = settings.get_strv(gkey);
        else if (type === 'int') value = settings.get_int(gkey);
        else if (type === 'double') value = settings.get_double(gkey);
        else if (type === 'boolean') value = settings.get_boolean(gkey);
        else value = settings.get_string(gkey);
        setConfigValue(config, path, value);
    }
    writeConfigYaml(config);
}
