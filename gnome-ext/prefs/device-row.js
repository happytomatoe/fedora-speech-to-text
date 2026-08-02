// @ts-check
/**
 * Microphone device selector row.
 */
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DeviceListIface = `
<node>
  <interface name="com.happytomatoe.VoiceToText">
    <method name="ListInputDevices">
      <arg type="a(ss)" name="devices" direction="out"/>
    </method>
  </interface>
</node>`;

/**
 * Create the microphone device selector row.
 * @param {Gio.Settings} settings
 * @returns {{ row: Adw.ActionRow, populate: () => void }}
 */
export function createDeviceRow(settings) {
    const row = new Adw.ActionRow({
        title: _('Microphone'),
        subtitle: _('Audio input device used for recording'),
    });

    const deviceCombo = new Gtk.ComboBoxText();
    deviceCombo.append('__system_default__', _('System default'));
    row.add_suffix(deviceCombo);

    const currentDevice =
        settings.get_string('input-device') || '__system_default__';
    deviceCombo.set_active_id(currentDevice);

    // Create D-Bus proxy for listing input devices
    const DeviceListProxy = Gio.DBusProxy.makeProxyWrapper(DeviceListIface);
    let deviceProxy = null;
    // @ts-expect-error - makeProxyWrapper returns a constructor but types don't reflect this
    deviceProxy = new DeviceListProxy(
        Gio.DBus.session,
        'com.happytomatoe.VoiceToText',
        '/com/happytomatoe/VoiceToText',
        (proxy, error) => {
            if (error) {
                console.error(
                    'VoiceToText: failed to create device list proxy:',
                    error.message
                );
                deviceProxy = null;
            }
        },
        null,
        Gio.DBusProxyFlags.DO_NOT_AUTO_START
    );

    const populate = () => {
        if (!deviceProxy) {
            row.subtitle = _('Voice-to-Text service not available');
            return;
        }
        deviceProxy
            .ListInputDevicesAsync()
            .then(
                devices => {
                    deviceCombo.remove_all();
                    deviceCombo.append(
                        '__system_default__',
                        _('System default')
                    );
                    for (const [id, label] of devices) {
                        if (id === '__system_default__') continue;
                        deviceCombo.append(id, label);
                    }
                    const active =
                        settings.get_string('input-device') ||
                        '__system_default__';
                    if (deviceCombo.get_active_id() !== active) {
                        deviceCombo.set_active_id(active);
                    }
                    row.subtitle = _('Audio input device used for recording');
                    return undefined;
                },
                err => {
                    row.subtitle = _(
                        'Start the Voice-to-Text service to list microphones'
                    );
                    console.error(
                        'VoiceToText: ListInputDevices failed:',
                        err?.message || err
                    );
                }
            )
            .catch(e =>
                console.error(
                    'VoiceToText: ListInputDevices unexpected error:',
                    e
                )
            );
    };

    deviceCombo.connect('changed', () => {
        const id = deviceCombo.get_active_id();
        if (id) {
            settings.set_string('input-device', id);
        }
    });

    return {row, populate};
}
