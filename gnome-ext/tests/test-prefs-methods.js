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
                if (imp.specifier.startsWith('./')) {
                    const path = GLib.build_filenamev([
                        prefsDir,
                        imp.specifier.substring(2),
                    ]);
                    if (!fileExists(path) && !fileExists(`${path}.js`)) {
                        missing.push(imp.specifier);
                    }
                }
            }
            assert(missing.length === 0, `Missing: ${missing.join(', ')}`);
        });
    }
} catch (e) {
    log(`  ⚠️ Could not read prefs/ directory: ${e.message}`);
}

// --- Summary ---

log(`\n${'═'.repeat(40)}`);
if (failed > 0) {
    log(`❌ ${failed} test(s) failed`);
    imports.system.exit(1);
} else {
    log('✅ All tests passed');
}
