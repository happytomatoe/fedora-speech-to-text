// @ts-check
/**
 * Custom words list widget for transcription correction.
 */
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio'; // eslint-disable-line no-unused-vars -- used in JSDoc
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Create the custom words group with list and add dialog.
 * @param {Gio.Settings} settings
 * @param {Gtk.Window} parentWindow
 * @param {() => Promise<void>} syncAllToConfig - Function to sync settings to config.yaml
 * @returns {{ group: Adw.PreferencesGroup, populate: () => void }}
 */
export function createCustomWordsGroup(
    settings,
    parentWindow,
    syncAllToConfig
) {
    const group = new Adw.PreferencesGroup({
        title: _('Custom Words'),
        description: _('Words/phrases for correction in transcription output'),
    });

    const customWordsList = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ['boxed-list'],
    });
    group.add(customWordsList);

    /** @type {Adw.ActionRow|null} */
    let addWordRow = null;

    // Use a mutable reference to break circular dependency between
    // createWordRow (which calls populate) and populate (which calls createWordRow)
    const ref = {populate: () => {}};

    // Helper to create a word row
    const createWordRow = word => {
        const row = new Adw.ActionRow();
        row.title = word;
        const deleteButton = new Gtk.Button({
            icon_name: 'edit-delete-symbolic',
            // Icon-only button — expose an accessible name so AT-SPI tests and
            // screen readers can target it.
            css_classes: ['flat', 'error'],
            valign: Gtk.Align.CENTER,
        });
        deleteButton.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [_('Delete %s').format(word)]
        );
        deleteButton.connect('clicked', () => {
            const wordToDelete = row.title;
            const currentWords = settings.get_strv('custom-words');
            settings.set_strv(
                'custom-words',
                currentWords.filter(w => w !== wordToDelete)
            );
            ref.populate();
            syncAllToConfig().catch(e =>
                console.error('VoiceToText: sync failed:', e)
            );
        });
        row.add_suffix(deleteButton);
        return row;
    };

    // Populate existing words from GSettings (called after config sync)
    ref.populate = () => {
        // Remove all word rows (but keep addWordRow)
        let child = customWordsList.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            if (
                child instanceof Adw.ActionRow &&
                addWordRow &&
                child !== addWordRow
            ) {
                customWordsList.remove(child);
            }
            child = next;
        }
        // Add words in reverse order so most recent appears at top
        const customWords = settings.get_strv('custom-words');
        for (let i = customWords.length - 1; i >= 0; i--) {
            if (customWords[i]) {
                customWordsList.append(createWordRow(customWords[i]));
            }
        }
    };

    // "Add Word…" row at the top. GTK4 rows expose no AT-SPI actions, so the
    // actual activation lives on a suffix button (clickable via AT-SPI).
    addWordRow = new Adw.ActionRow({
        activatable: true,
        title: _('Add Word…'),
        subtitle: _('Add a new word or phrase for correction'),
        icon_name: 'list-add-symbolic',
    });
    addWordRow.add_css_class('activatable');
    const addWordButton = new Gtk.Button({
        icon_name: 'list-add-symbolic',
        valign: Gtk.Align.CENTER,
    });
    addWordButton.update_property(
        [Gtk.AccessibleProperty.LABEL],
        [_('Add Word')]
    );
    const openAddDialog = () => {
        const dialog = new Gtk.Window({
            title: _('Add Custom Word'),
            modal: true,
            transient_for: parentWindow,
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
        const cancelButton = new Gtk.Button({label: _('Cancel')});
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
                // Check for duplicates
                const existing = settings.get_strv('custom-words');
                if (existing.includes(text)) {
                    dialog.close();
                    return;
                }
                // Persist insertion order (append to end of stored array)
                settings.set_strv('custom-words', [...existing, text]);
                ref.populate();
                try {
                    await syncAllToConfig();
                } catch (e) {
                    console.error('VoiceToText: sync failed:', e);
                }
            }
            dialog.close();
        };
        cancelButton.connect('clicked', () => dialog.close());
        addButton.connect('clicked', () =>
            doAdd().catch(e => console.error('VoiceToText: doAdd failed:', e))
        );
        entry.connect('activate', () =>
            doAdd().catch(e => console.error('VoiceToText: doAdd failed:', e))
        );

        dialog.present();
    };
    addWordButton.connect('clicked', openAddDialog);
    addWordRow.connect('activated', openAddDialog);
    addWordRow.add_suffix(addWordButton);
    // Add "Add Word…" row first so it appears at the top of the list
    customWordsList.append(addWordRow);

    return {group, populate: () => ref.populate()};
}
