#!/usr/bin/env gjs --module
// @ts-check
/**
 * Static analysis tests for GNOME extension JS files.
 * Catches common bugs before deployment:
 * - Missing method definitions (this.method() called but not defined)
 * - Missing required imports (ExtensionPreferences, gettext, etc.)
 * - Missing imported files on disk
 */

import GLib from 'gi://GLib';

/** @param {string} path */
function readFile(path) {
    const [ok, contents] = GLib.file_get_contents(path);
    if (!ok) throw new Error(`Failed to read ${path}`);
    return imports.byteArray.toString(contents);
}

/** @param {string} source */
function extractMethodDefinitions(source) {
    const methods = new Set();
    const pattern = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g;
    let m;
    while ((m = pattern.exec(source)) !== null) methods.add(m[1]);
    return methods;
}

/** @param {string} source */
function extractThisMethodCalls(source) {
    const calls = new Map();
    const pattern = /this\.(\w+)\s*\(/g;
    let m;
    while ((m = pattern.exec(source)) !== null) {
        if (!calls.has(m[1])) {
            const line = source.substring(0, m.index).split('\n').length;
            calls.set(m[1], line);
        }
    }
    return calls;
}

/** @param {string} source */
function extractImports(source) {
    const result = [];
    const pattern = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = pattern.exec(source)) !== null) {
        result.push({
            specifier: m[1],
            line: source.substring(0, m.index).split('\n').length,
        });
    }
    return result;
}

// --- Test cases ---

// Get the directory where this script lives (not cwd)
const SCRIPT_DIR = GLib.path_get_dirname(
    import.meta.url.replace('file://', '')
);
const DIR = GLib.build_filenamev([SCRIPT_DIR, '..']);
let failed = 0;

/**
 * @param {string} name
 * @param {() => void} fn
 */
function test(name, fn) {
    try {
        fn();
        log(`  ✅ ${name}`);
    } catch (e) {
        log(`  ❌ ${name}: ${e.message}`);
        failed++;
    }
}

/** @param {boolean} cond */
function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

/** @param {string} path */
function fileExists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

// --- prefs.js tests ---

log('── prefs.js ──');
const prefsSrc = readFile(GLib.build_filenamev([DIR, 'prefs.js']));

test('ExtensionPreferences is imported', () => {
    assert(
        prefsSrc.includes('ExtensionPreferences'),
        'Missing ExtensionPreferences import'
    );
});

test('gettext is imported', () => {
    assert(prefsSrc.includes('gettext'), 'Missing gettext import');
});

test('All this.method() calls have definitions', () => {
    const defs = extractMethodDefinitions(prefsSrc);
    const calls = extractThisMethodCalls(prefsSrc);
    const missing = [];
    const parentMethods = [
        'getSettings',
        'getPath',
        'getSessionMode',
        'getMetadata',
        'getUuid',
    ];
    for (const [name, line] of calls) {
        if (!parentMethods.includes(name) && !defs.has(name)) {
            missing.push(`line ${line}: this.${name}()`);
        }
    }
    assert(missing.length === 0, `Undefined methods: ${missing.join(', ')}`);
});

test('All imported modules exist on disk', () => {
    const imports = extractImports(prefsSrc);
    const missing = [];
    for (const imp of imports) {
        if (imp.specifier.startsWith('./') || imp.specifier.startsWith('../')) {
            // Resolve relative to the prefs/ directory
            const parts = imp.specifier.split('/');
            let baseDir = DIR;
            for (const part of parts) {
                if (part === '..') {
                    baseDir = GLib.path_get_dirname(baseDir);
                } else if (part !== '.') {
                    baseDir = GLib.build_filenamev([baseDir, part]);
                }
            }
            if (!fileExists(baseDir) && !fileExists(`${baseDir}.js`)) {
                missing.push(`${imp.specifier} (line ${imp.line})`);
            }
    }
    assert(missing.length === 0, `Missing files: ${missing.join(', ')}`);
});

// --- Regression: GNOME 50 Adw.PreferencesWindow.add_action missing ---

log('\n── GNOME 50 compatibility ──');

test('prefs.js does not use window.add_action (deprecated on Adw.PreferencesWindow)', () => {
    // Adw.PreferencesWindow is deprecated since libadwaita 1.6 (GNOME 50+).
    // The GJS bindings no longer expose add_action from Gio.ActionMap.
    // Keyboard shortcuts must use Gtk.EventControllerKey instead.
    const hasAddAction = /window\.add_action\s*\(/.test(prefsSrc);
    assert(
        !hasAddAction,
        'prefs.js uses window.add_action which is unavailable on Adw.PreferencesWindow in GNOME 50+.' +
            ' Use Gtk.EventControllerKey for keyboard shortcuts instead.'
    );
});

test('prefs.js uses EventControllerKey for keyboard shortcuts', () => {
    // Check for actual construction, not just comments
    const hasKeyController = /new\s+EventControllerKey\s*\(/.test(prefsSrc);
    assert(
        hasKeyController,
        'prefs.js should use Gtk.EventControllerKey for keyboard shortcuts'
    );
});

// --- extension.js tests ---

log('\n── extension.js ──');
const extSrc = readFile(GLib.build_filenamev([DIR, 'extension.js']));

test('Extension is exported', () => {
    assert(
        extSrc.includes('export default class'),
        'No default class export found'
    );
});

test('All this.method() calls have definitions', () => {
    const defs = extractMethodDefinitions(extSrc);
    const calls = extractThisMethodCalls(extSrc);
    const missing = [];
    const lifecycle = [
        'enable',
        'disable',
        'getSettings',
        'getPath',
        'getSessionMode',
        'getMetadata',
        'getUuid',
    ];
    for (const [name, line] of calls) {
        if (!lifecycle.includes(name) && !defs.has(name)) {
            missing.push(`line ${line}: this.${name}()`);
        }
    }
    assert(missing.length === 0, `Undefined methods: ${missing.join(', ')}`);
});

test('All imported modules exist on disk', () => {
    const imports = extractImports(extSrc);
    const missing = [];
    for (const imp of imports) {
        if (imp.specifier.startsWith('./')) {
            const path = GLib.build_filenamev([
                DIR,
                imp.specifier.substring(2),
            ]);
            if (!fileExists(path) && !fileExists(`${path}.js`)) {
                missing.push(`${imp.specifier} (line ${imp.line})`);
            }
        }
    }
    assert(missing.length === 0, `Missing files: ${missing.join(', ')}`);
});

// --- prefs/*.js tests ---

log('\n── prefs/*.js modules ──');
const prefsDir = GLib.build_filenamev([DIR, 'prefs']);
try {
    const dir = GLib.Dir.open(prefsDir, 0);
    let entry;
    while ((entry = dir.read_name()) !== null) {
        if (!entry.endsWith('.js')) continue;
        const src = readFile(GLib.build_filenamev([prefsDir, entry]));

        test(`${entry}: exported functions are defined`, () => {
            const exported = [];
            const pattern = /export\s+(?:async\s+)?function\s+(\w+)/g;
            let m;
            while ((m = pattern.exec(src)) !== null) exported.push(m[1]);
            assert(exported.length > 0, 'No exported functions found');
        });

        test(`${entry}: all imported modules exist`, () => {
            const imports = extractImports(src);
            const missing = [];
            for (const imp of imports) {
                if (imp.specifier.startsWith('./') || imp.specifier.startsWith('../')) {
                    // Resolve relative to prefs/ for ./ and ../ specifiers
                    const parts = imp.specifier.split('/');
                    let baseDir = imp.specifier.startsWith('../') ? DIR : prefsDir;
                    for (const part of parts) {
                        if (part === '..') {
                            baseDir = GLib.path_get_dirname(baseDir);
                        } else if (part !== '.') {
                            baseDir = GLib.build_filenamev([baseDir, part]);
                        }
                    }
                    if (!fileExists(baseDir) && !fileExists(`${baseDir}.js`)) {
                        missing.push(imp.specifier);
                    }
                }
            }
            assert(missing.length === 0, `Missing: ${missing.join(', ')}`);
        });
    }
} catch (e) {
    log(`  ⚠️ Could not read prefs/ directory: ${e.message}`);
    failed = true;
}

// --- Regression: St.Clipboard API (GNOME 50) ---

log('\n── St.Clipboard API (GNOME 50) ──');
const serviceSrc = readFile(
    GLib.build_filenamev([DIR, 'type-text-service.js'])
);

test('type-text-service uses get_text instead of get_content for text', () => {
    // get_content requires (type, mimetype, callback) — overkill for text.
    // get_text is the simple text API: get_text(type, callback).
    const hasGetContent = /\.get_content\s*\(/.test(serviceSrc);
    assert(
        !hasGetContent,
        'type-text-service.js uses get_content() which requires GBytes callback.' +
            ' Use get_text(type, callback) for text operations.'
    );
});

test('type-text-service uses set_text instead of set_content for text', () => {
    // set_content requires GBytes, not a string.
    // set_text accepts a plain string.
    const hasSetContent = /\.set_content\s*\(/.test(serviceSrc);
    assert(
        !hasSetContent,
        'type-text-service.js uses set_content() which requires GBytes.' +
            ' Use set_text(type, text) for text operations.'
    );
});

test('type-text-service does not use clipboard.clear()', () => {
    // St.Clipboard.clear() was removed in GNOME 50.
    const hasClear = /\.clear\s*\(/.test(serviceSrc);
    assert(
        !hasClear,
        'type-text-service.js uses clipboard.clear() which was removed in GNOME 50.'
    );
});
test('type-text-service uses get_text and set_text', () => {
    // Positive assertions: ensure the replacement APIs are present
    const hasGetText = /get_text\s*\(/.test(serviceSrc);
    const hasSetText = /set_text\s*\(/.test(serviceSrc);
    assert(hasGetText, 'type-text-service.js should use get_text() for clipboard reads');
    assert(hasSetText, 'type-text-service.js should use set_text() for clipboard writes');
});
// --- Summary ---

log(`\n${'═'.repeat(40)}`);
if (failed > 0) {
    log(`❌ ${failed} test(s) failed`);
    imports.system.exit(1);
} else {
    log('✅ All tests passed');
}
