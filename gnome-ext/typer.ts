import St from 'gi://St';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

function _showNotification(message: string): void {
    const systemSource = MessageTray.getSystemSource();
    const notification = new MessageTray.Notification({
        source: systemSource,
        title: 'Voice to Text',
        body: message,
        iconName: 'audio-input-microphone-symbolic',
    });
    systemSource.addNotification(notification);
}

export function copyToClipboard(text: string): void {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}
