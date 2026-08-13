#!/usr/bin/env gjs --module
// @ts-check
/**
 * Verify GTK4 widget APIs used in prefs.js actually exist.
 * Catches GTK3→GTK4 regressions where removed APIs are used.
 */

import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

let failed = 0;

function test(name, fn) {
    try {
        fn();
        log(`  ✅ ${name}`);
    } catch (e) {
        log(`  ❌ ${name}: ${e.message}`);
        failed++;
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

// --- GTK4 API existence checks ---

log('── GTK4 widget APIs ──');

test('Gtk.EventControllerKey exists', () => {
    assert(
        typeof Gtk.EventControllerKey === 'function',
        'Gtk.EventControllerKey not found'
    );
});

test('Gtk.Box exists', () => {
    assert(typeof Gtk.Box === 'function', 'Gtk.Box not found');
});

test('Gtk.Label exists', () => {
    assert(typeof Gtk.Label === 'function', 'Gtk.Label not found');
});

test('Gtk.Button exists', () => {
    assert(typeof Gtk.Button === 'function', 'Gtk.Button not found');
});

test('Gtk.Switch exists', () => {
    assert(typeof Gtk.Switch === 'function', 'Gtk.Switch not found');
});

test('Gtk.ComboBoxText exists', () => {
    assert(
        typeof Gtk.ComboBoxText === 'function',
        'Gtk.ComboBoxText not found'
    );
});

test('Adw.PreferencesWindow exists', () => {
    assert(
        typeof Adw.PreferencesWindow === 'function',
        'Adw.PreferencesWindow not found'
    );
});

test('Adw.PreferencesGroup exists', () => {
    assert(
        typeof Adw.PreferencesGroup === 'function',
        'Adw.PreferencesGroup not found'
    );
});

test('Adw.ActionRow exists', () => {
    assert(typeof Adw.ActionRow === 'function', 'Adw.ActionRow not found');
});

test('Adw.ComboRow exists', () => {
    assert(typeof Adw.ComboRow === 'function', 'Adw.ComboRow not found');
});

test('Adw.SwitchRow exists', () => {
    assert(typeof Adw.SwitchRow === 'function', 'Adw.SwitchRow not found');
});

log(`\n${'═'.repeat(40)}`);
if (failed > 0) {
    log(`❌ ${failed} test(s) failed`);
    imports.system.exit(1);
} else {
    log('✅ All GTK4 API checks passed');
}
