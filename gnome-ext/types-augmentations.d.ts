// Import ambient type declarations for GNOME Shell resource:// modules
// This makes imports like 'resource:///org/gnome/shell/ui/main.js' resolve to @girs types
import '@girs/gnome-shell/ambient';

// GJS sets import.meta.url to the file's resource:// URI
declare global {
    interface ImportMeta {
        url: string;
    }
}
