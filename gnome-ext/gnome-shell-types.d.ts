// Custom type declarations for GNOME Shell APIs missing from @girs packages.
// These supplement the @girs/gnome-shell types with properties that exist at runtime
// but are not yet declared in the type definitions.

declare module 'resource:///org/gnome/shell/extensions/extension.js' {
    export function gettext(str: string): string;
    export class Extension {
        uuid: string;
        getSettings(): any;
        getPath(): string;
        [key: string]: any;
    }
}

declare module 'resource:///org/gnome/shell/ui/main.js' {
    export const layoutManager: any;
    export const wm: any;
    export const inputMethod: any;
}

declare module 'resource:///org/gnome/shell/ui/messageTray.js' {
    export function getSystemSource(): any;
    export class Notification {
        constructor(params: any);
        [key: string]: any;
    }
}

declare module 'resource:///org/gnome/shell/ui/panelMenu.js' {
    export class Button {
        constructor(...args: any[]);
        [key: string]: any;
    }
}

declare module 'resource:///org/gnome/shell/ui/panel.js' {
    export const Panel: any;
}

declare module 'resource:///org/gnome/shell/ui/popupMenu.js' {
    export class PopupMenuItem {
        constructor(...args: any[]);
        set_accessible_name(name: string): void;
        connect(signal: string, callback: (...args: any[]) => void): number;
        [key: string]: any;
    }
}

// Augment St module for SpinnerContent
declare module 'gi://St' {
    const SpinnerContent: any;
}

// Augment ImportMeta for GJS
interface ImportMeta {
    url: string;
}
