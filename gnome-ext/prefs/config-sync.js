// @ts-check
/**
 * Config YAML ↔ GSettings synchronization.
 *
 * Pure utility functions — no GTK/Adw imports needed.
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
    'vad-enabled': {path: ['engine', 'vad_enabled'], type: 'boolean'},
};

// Default config values written to config.yaml when creating or updating.
// These match the schema defaults and engine.py fallbacks.
const DEFAULT_CONFIG = {
    transcription: {
        mode: 'batch',
        provider: 'voxtral',
        language: 'en',
        hybrid: {
            streaming_provider: 'voxtral',
            batch_provider: 'voxtral',
        },
    },
    audio: {
        sample_rate: 16000,
        channels: 1,
        block_size: 2048,
        smooth_factor: 0.7,
        bluetooth_mic: true,
        speaker: {
            decrease_volume: 50,
        },
    },
    engine: {
        stop_timeout: 300,
        output_method: 'mutter-virtual',
        vad_enabled: true,
    },
    logging: {
        file: '/tmp/voice-to-text.log',
        level: 'info',
    },
    postprocess: {
        enabled: true,
        language: null,
        custom_words: [],
        custom_words_threshold: 0.5,
    },
    profiling: false,
};

/**
 * Deep merge: write src into dest, creating nested objects as needed.
 * Arrays are replaced, not merged.
 * @param {object} dest
 * @param {object} src
 */
function deepMerge(dest, src) {
    for (const [key, val] of Object.entries(src)) {
        if (val != null && typeof val === 'object' && !Array.isArray(val)) {
            if (
                dest[key] == null ||
                typeof dest[key] !== 'object' ||
                Array.isArray(dest[key])
            ) {
                dest[key] = {};
            }
            deepMerge(dest[key], val);
        } else {
            dest[key] = val;
        }
    }
}

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

function writeConfigYaml(config) {
    const file = Gio.File.new_for_path(CONFIG_PATH);
    // Ensure parent directory exists
    const parent = file.get_parent();
    if (parent && !parent.query_exists(null)) {
        parent.make_directory_with_parents(null);
    }
    const yamlStr = yamlDump(config);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(yamlStr);
    const [ok] = file.replace_contents(
        bytes,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
    if (!ok) {
        console.error('VoiceToText: failed to write config.yaml');
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

        // Type validation before writing
        if (type === 'int' && !Number.isInteger(cfgVal)) {
            console.warn(
                `VoiceToText: skipping ${gkey}: expected int, got ${typeof cfgVal}`
            );
            continue;
        }
        if (type === 'double' && typeof cfgVal !== 'number') {
            console.warn(
                `VoiceToText: skipping ${gkey}: expected number, got ${typeof cfgVal}`
            );
            continue;
        }
        if (type === 'string' && typeof cfgVal !== 'string') {
            console.warn(
                `VoiceToText: skipping ${gkey}: expected string, got ${typeof cfgVal}`
            );
            continue;
        }
        if (type === 'strv' && !Array.isArray(cfgVal)) {
            console.warn(
                `VoiceToText: skipping ${gkey}: expected array, got ${typeof cfgVal}`
            );
            continue;
        }

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
            if (settings.get_user_value(gkey) === null && gsetVal !== cfgVal) {
                settings.set_double(gkey, cfgVal);
                gsetVal = cfgVal;
            }
            if (gsetVal !== cfgVal) drifted.push(gkey);
        } else {
            gsetVal = settings.get_string(gkey);
            if (settings.get_user_value(gkey) === null && gsetVal !== cfgVal) {
                settings.set_string(gkey, cfgVal);
                gsetVal = cfgVal;
            }
            if (gsetVal !== cfgVal) drifted.push(gkey);
        }
    }
    return {config, drifted};
}

/**
 * Deep clone an object (structuredClone not available in GJS).
 * @param {object} obj
 * @returns {object}
 */
function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Write all mapped settings from GSettings to config.yaml.
 * On first run (no config file), writes DEFAULT_CONFIG + GSettings overrides.
 * On subsequent runs, deep-merges defaults so new keys appear.
 * @param {Gio.Settings} settings
 */
export function syncToConfig(settings) {
    // Start with defaults so all keys are present in config.yaml
    const config = deepClone(DEFAULT_CONFIG);

    // Layer on existing config (preserves provider-specific sections, etc.)
    const existing = readConfigYaml();
    if (existing) {
        deepMerge(config, existing);
    }

    // Overlay GSettings values
    for (const [gkey, {path, type}] of Object.entries(CONFIG_SYNC_MAP)) {
        let value;
        if (type === 'strv') value = settings.get_strv(gkey);
        else if (type === 'int') value = settings.get_int(gkey);
        else if (type === 'double') value = settings.get_double(gkey);
        else value = settings.get_string(gkey);
        setConfigValue(config, path, value);
    }
    writeConfigYaml(config);
}
