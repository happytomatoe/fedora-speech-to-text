import '@girs/gjs';
import '@girs/gjs/dom';
import '@girs/gnome-shell/ambient';
import '@girs/gnome-shell/extensions/global';

// Declare module extensions for GNOME Shell imports
declare module 'resource:///org/gnome/shell/ui/main.js' {
  import { layoutManager } from '@girs/gnome-shell/src/ui/main';
  export const layoutManager: typeof layoutManager;
  export const panel: any;
  export const wm: any;
}

declare module 'resource:///org/gnome/shell/extensions/extension.js' {
  export class Extension {
    metadata: any;
    getSettings(schema?: string): any;
    gettext(str: string): string;
  }
  export function gettext(str: string): string;
}

declare module 'resource:///org/gnome/shell/ui/panelMenu.js' {
  import { Button } from '@girs/gnome-shell/src/ui/panelMenu';
  export { Button };
}

declare module 'resource:///org/gnome/shell/ui/popupMenu.js' {
  export class PopupMenuItem {
    constructor(text: string, params?: any);
    connect(signal: string, callback: (...args: any[]) => void): number;
  }
  export class PopupMenu {
    removeAll(): void;
    addMenuItem(item: any): void;
  }
}

declare module 'resource:///org/gnome/shell/ui/messageTray.js' {
  export function getSystemSource(): any;
  export class Notification {
    constructor(params: {
      source: any;
      title: string;
      body: string;
      iconName: string;
    });
  }
}
