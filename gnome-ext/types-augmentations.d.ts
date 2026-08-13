// Supplemental type augmentations for GNOME Shell APIs.
// Import ambient type declarations for GNOME Shell resource:// modules
import '@girs/gnome-shell/ambient';
// These supplement the @girs/gnome-shell types with properties that exist at runtime
// but are not yet declared in the type definitions.

// Augment PopupMenu to include methods that exist on the actual PopupMenu class
declare module 'resource:///org/gnome/shell/ui/popupMenu.js' {
    export class PopupMenu {
        removeAll(): void;
        addMenuItem(item: any, position?: number): void;
        [key: string]: any;
    }
}

// Augment ImportMeta for GJS
declare global {
    interface ImportMeta {
        url: string;
    }
}
