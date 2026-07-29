// Type declarations for GJS/GNOME Shell environment
// These are not provided by @girs packages

declare const console: {
    log(...args: unknown[]): void;
    error(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    info(...args: unknown[]): void;
    debug(...args: unknown[]): void;
};

declare class TextDecoder {
    constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
    decode(input?: BufferSource, options?: { stream?: boolean }): string;
}

declare class TextEncoder {
    constructor();
    encode(input?: string): Uint8Array;
    encodeInto(src: string, dest: Uint8Array): { read: number; written: number };
}

// GNOME Shell APIs (no @girs types available)
declare module 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js' {
    export class ExtensionPreferences {
        getSettings(schema?: string): any;
    }
    export function gettext(str: string): string;
}

declare module 'resource:///org/gnome/shell/extensions/extension.js' {
    export class Extension {
        readonly metadata: { [key: string]: any };
        readonly path: string;
        getSettings(schema?: string): any;
        gettext(str: string): string;
    }
}

declare module 'resource:///org/gnome/shell/ui/main.js' {
    export const panel: any;
    export const messageTray: any;
}

declare module 'resource:///org/gnome/shell/ui/messageTray.js' {
    export class MessageTray {
        add(message: any): void;
    }
}

declare module 'resource:///org/gnome/shell/ui/panelMenu.js' {
    export class PanelMenuButton {
        constructor(menuAlignment: number, name: string, params?: any);
        menu: any;
        add_child(child: any): void;
    }
}

declare module 'resource:///org/gnome/shell/ui/popupMenu.js' {
    export class PopupMenuSection {
        addMenuItem(item: any): void;
    }
    export class PopupMenuItem {
        constructor(label: string, params?: any);
    }
}

// St (GNOME Shell toolkit) - minimal declarations
declare module 'gi://St' {
    export class Widget {
        add_child(child: any): void;
        set_style(style: string): void;
        show(): void;
        hide(): void;
        destroy(): void;
    }
    export class Label extends Widget {
        constructor(params?: any);
        set_text(text: string): void;
        set_style(style: string): void;
    }
    export class Box extends Widget {
        constructor(params?: any);
        add_child(child: any): void;
    }
}

// Clutter
declare module 'gi://Clutter' {
    export class Actor {
        add_child(child: any): void;
        remove_child(child: any): void;
        destroy(): void;
    }
}

// GObject
declare module 'gi://GObject' {
    export class Object {}
    export function registerClass(...args: any[]): any;
}

// Shell
declare module 'gi://Shell' {
    export class AppSystem {
        static get_default(): AppSystem;
        lookup_app(appId: string): any;
    }
}

// Meta
declare module 'gi://Meta' {
    export class Display {
        get_focus_window(): any;
    }
}

// Main module
declare module 'resource:///org/gnome/shell/ui/main.js' {
    export const panel: any;
    export const messageTray: any;
    export function notify(title: string, body: string): void;
}
