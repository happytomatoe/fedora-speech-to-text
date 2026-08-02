import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {VoiceIndicator} from './indicator.js';
import {registerHotkey, unregisterHotkey} from './hotkey.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {AudioLevelWidget} from './audio-level-widget.js';
import Clutter from 'gi://Clutter';

const VoiceToTextIface = `
<node>
  <interface name="com.happytomatoe.VoiceToText">
    <method name="StartRecording">
      <arg type="s" name="config" direction="in"/>
    </method>
    <method name="StopRecording"/>
    <method name="GetStatus">
      <arg type="s" direction="out"/>
    </method>
    <signal name="AudioLevel">
      <arg type="d" name="level"/>
    </signal>
    <signal name="Error">
      <arg type="s" name="message"/>
    </signal>
    <signal name="StateChanged">
      <arg type="s" name="state"/>
    </signal>
  </interface>
</node>`;

const VoiceToTextProxy = Gio.DBusProxy.makeProxyWrapper(VoiceToTextIface);

const TypeTextIface = `
<node>
  <interface name="com.happytomatoe.TypeText">
    <method name="TypeText">
      <arg type="s" name="text" direction="in"/>
    </method>
  </interface>
</node>`;

class TypeTextService {
    constructor() {
        this._virtualKeyboard = null;
        this._dbusImpl = null;
        this._ownerId = null;
    }

    enable() {
        // Get virtual keyboard via Clutter
        try {
            const backend = Clutter.get_default_backend();
            const seat = backend.get_default_seat();
            this._virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            if (this._virtualKeyboard) {
                console.log('VoiceToText: TypeText virtual keyboard obtained');
            } else {
                console.log('VoiceToText: TypeText virtual keyboard not available');
            }
        } catch (e) {
            console.error('VoiceToText: TypeText failed to get virtual keyboard:', e);
        }

        // Claim bus name + export object
        try {
            this._ownerId = Gio.bus_own_name(
                Gio.BusType.SESSION,
                'com.happytomatoe.TypeText',
                Gio.BusNameOwnerFlags.NONE,
                (connection, _name) => {
                    // Bus acquired — export D-Bus object
                    try {
                        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(TypeTextIface, this);
                        this._dbusImpl.export(connection, '/com/happytomatoe/TypeText');
                        console.log('VoiceToText: TypeText D-Bus object exported at /com/happytomatoe/TypeText');
                    } catch (e) {
                        console.error('VoiceToText: TypeText D-Bus export failed:', e);
                    }
                },
                (connection, name) => {
                    console.log(`VoiceToText: bus name acquired: ${name}`);
                },
                (connection, _name) => {
                    console.error(`VoiceToText: bus name lost: ${_name}`);
                }
            );
            console.log('VoiceToText: bus_own_name called for com.happytomatoe.TypeText');
        } catch (e) {
            console.error('VoiceToText: bus_own_name failed:', e);
        }
    }

    disable() {
        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = null;
        }
        this._virtualKeyboard = null;
    }

    TypeText(text) {
        if (!this._virtualKeyboard) {
            console.log('VoiceToText: TypeText virtual keyboard not available');
            return;
        }
        console.log(`VoiceToText: TypeText typing ${text.length} chars`);
        try {
            let time = Clutter.get_current_event_time() || Date.now();
            for (const char of text) {
                if (char === '\n') {
                    this._virtualKeyboard.notify_keyval(time++, Clutter.KEY_Return, Clutter.KeyState.PRESSED);
                    this._virtualKeyboard.notify_keyval(time++, Clutter.KEY_Return, Clutter.KeyState.RELEASED);
                } else {
                    const charCode = char.charCodeAt(0);
                    const keyval = Clutter.unicode_to_keyval(charCode);
                    if (keyval !== 0) {
                        this._virtualKeyboard.notify_keyval(time++, keyval, Clutter.KeyState.PRESSED);
                        this._virtualKeyboard.notify_keyval(time++, keyval, Clutter.KeyState.RELEASED);
                    }
                }
            }
        } catch (e) {
            console.error('VoiceToText: TypeText failed:', e);
        }
    }
}

const SessionManagerIface =
    '<node>\
  <interface name="org.gnome.SessionManager">\
    <method name="Inhibit">\
      <arg type="s" direction="in"/>\
      <arg type="u" direction="in"/>\
      <arg type="s" direction="in"/>\
      <arg type="u" direction="in"/>\
      <arg type="u" direction="out"/>\
    </method>\
    <method name="Uninhibit">\
      <arg type="u" direction="in"/>\
    </method>\
  </interface>\
</node>';

const SessionManagerProxy = Gio.DBusProxy.makeProxyWrapper(SessionManagerIface);

export default class VoiceToTextExtension extends Extension {
    enable() {
        this._settings = this.getSettings(
            'org.gnome.shell.extensions.voice-to-text'
        );
        this._indicator = new VoiceIndicator();
        this._proxy = null;
        this._recording = false;
        this._hotkeySignalId = null;
        this._signalIds = [];
        // Log audio level widget setting on startup
        let showAudioLevel = false;
        try {
            showAudioLevel = this._settings.get_boolean('show-audio-level-widget');
        } catch {
            // Key may not exist in older schema versions
            showAudioLevel = true; // default to showing
        }
        console.log(`VoiceToText: show-audio-level-widget = ${showAudioLevel}`);
        this._audioLevelWidget = showAudioLevel ? new AudioLevelWidget() : null;
        this._typeTextService = new TypeTextService();
        this._typeTextService.enable();
        this._indicator.onStart = () => this._start();
        this._indicator.onStop = () => this._stop();
        this._indicator.onConfigure = () => this._openPreferences();

        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._registerHotkey();

        // Listen for hotkey changes
        this._hotkeySignalId = this._settings.connect('changed::hotkey', () => {
            this._registerHotkey();
        });
        // Listen for audio level widget changes
        this._audioLevelWidgetSignalId = this._settings.connect(
            'changed::show-audio-level-widget',
            () => {
                const enabled = this._settings.get_boolean('show-audio-level-widget');
                console.log(`VoiceToText: show-audio-level-widget changed to ${enabled}`);
                if (enabled && !this._audioLevelWidget) {
                    this._audioLevelWidget = new AudioLevelWidget();
                    if (this._recording) this._audioLevelWidget.show();
                    console.log('VoiceToText: AudioLevelWidget created');
                } else if (!enabled && this._audioLevelWidget) {
                    this._audioLevelWidget.destroy();
                    this._audioLevelWidget = null;
                    console.log('VoiceToText: AudioLevelWidget destroyed');
                }
            }
        );

        this._inhibitCookie = 0;
        this._sessionManager = new SessionManagerProxy(
            Gio.DBus.session,
            'org.gnome.SessionManager',
            '/org/gnome/SessionManager'
        );

        this._connectDBus();
    }

    disable() {
        this._unregisterHotkey();

        if (this._hotkeySignalId) {
            this._settings.disconnect(this._hotkeySignalId);
            this._hotkeySignalId = null;
        }
        if (this._audioLevelWidgetSignalId) {
            this._settings.disconnect(this._audioLevelWidgetSignalId);
            this._audioLevelWidgetSignalId = null;
        }

        this._disconnectDBusSignals();

        if (this._recording) {
            this._stop();
        }

        this._releaseInhibitor();
        this._sessionManager = null;
        this._proxy = null;

        this._typeTextService?.disable();
        this._typeTextService = null;
        this._audioLevelWidget?.destroy();
        this._audioLevelWidget = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        this._recording = false;
    }

    _toggle() {
        console.log('VoiceToText: _toggle called');
        if (this._recording) {
            this._stop();
        } else {
            this._start();
        }
    }

    _registerHotkey() {
        this._unregisterHotkey();

        try {
            registerHotkey('hotkey', this._settings, () => this._toggle());
            console.log('VoiceToText: hotkey registered');
        } catch (e) {
            console.error('VoiceToText: failed to register hotkey:', e.message);
        }
    }

    _unregisterHotkey() {
        try {
            unregisterHotkey('hotkey');
            console.log('VoiceToText: hotkey unregistered');
        } catch (e) {
            console.error(
                'VoiceToText: failed to unregister hotkey:',
                e.message
            );
        }
    }

    _connectDBus() {
        try {
            this._proxy = new VoiceToTextProxy(
                Gio.DBus.session,
                'com.happytomatoe.VoiceToText',
                '/com/happytomatoe/VoiceToText'
            );

            // Connect signals
            this._signalIds = [];

            const stateId = this._proxy.connectSignal(
                'StateChanged',
                (proxy, name, [state]) => {
                    console.log('VoiceToText: state changed to', state);
                    if (state === 'recording') {
                        this._indicator?.setRecordingActive();
                        this._audioLevelWidget?.show();
                    } else if (state === 'processing') {
                        this._indicator?.setProcessing();
                    } else if (state === 'idle') {
                        this._indicator?.setRecording(false);
                        this._audioLevelWidget?.hide();
                        this._recording = false;
                        this._releaseInhibitor();
                    }
                }
            );
            this._signalIds.push(stateId);

            const levelId = this._proxy.connectSignal(
                'AudioLevel',
                (proxy, name, [level]) => {
                    this._audioLevelWidget?.updateLevel(level);
                }
            );
            this._signalIds.push(levelId);

            const errorId = this._proxy.connectSignal(
                'Error',
                (proxy, name, [msg]) => {
                    console.log('VoiceToText: error:', msg);
                    this._showNotification(`Transcription failed: ${msg}`);
                }
            );
            this._signalIds.push(errorId);

            console.log('VoiceToText: D-Bus proxy connected');

            // Sync state on (re)enable — engine may already be recording
            const proxyRef = this._proxy;
            this._proxy.GetStatusAsync().then(
                state => {
                    // Guard: extension may have been disabled or re-enabled while promise was pending
                    if (this._proxy !== proxyRef) return;
                    console.log('VoiceToText: initial state:', state);
                    if (state === 'recording' || state === 'processing') {
                        this._recording = true;
                        if (state === 'processing') {
                            this._indicator?.setProcessing();
                        } else {
                            this._indicator?.setRecordingActive();
                        }
                        this._ensureInhibitor();
                    }
                },
                () => {} // ignore errors during init
            );
        } catch (e) {
            console.error(
                'VoiceToText: failed to connect to D-Bus service:',
                e.message
            );
            this._showNotification('Voice-to-Text D-Bus service not running. ');
        }
    }

    _disconnectDBusSignals() {
        if (this._proxy && this._signalIds.length > 0) {
            for (const id of this._signalIds) {
                try {
                    this._proxy.disconnectSignal(id);
                } catch {
                    // ignore: signal may already be disconnected or proxy destroyed
                }
            }
            this._signalIds = [];
        }
    }

    _start() {
        console.log('VoiceToText: _start called');
        if (this._recording) return;

        if (!this._proxy) {
            console.log('VoiceToText: D-Bus proxy not available');
            this._showNotification('Voice-to-Text D-Bus service not available');
            return;
        }

        if (!this._indicator) {
            console.log('VoiceToText: indicator not available');
            return;
        }

        this._indicator.setProcessing();
        this._recording = true;

        const config = {
            provider: this._settings.get_string('provider'),
            language: this._settings.get_string('language'),
            mode: this._settings.get_string('mode'),
            streaming_provider: this._settings.get_string('streaming-provider'),
            batch_provider: this._settings.get_string('batch-provider'),
            device: this._settings.get_string('input-device'),
            decrease_speaker_volume: this._settings.get_int(
                'decrease-speaker-volume'
            ),
            output_method: this._settings.get_string('output-method'),
            stop_timeout: this._settings.get_int('stop-timeout-seconds'),
            custom_words: this._settings.get_strv('custom-words'),
            custom_words_threshold: this._settings.get_double('custom-words-threshold'),
        };

        this._proxy.StartRecordingAsync(JSON.stringify(config)).then(
            () => console.log('VoiceToText: StartRecording called via D-Bus'),
            e => {
                console.error(
                    'VoiceToText: D-Bus StartRecording failed:',
                    e.message
                );
                this._showNotification(
                    `Failed to start recording: ${e.message}`
                );
                this._recording = false;
                this._releaseInhibitor();
                this._indicator.setRecording(false);
            }
        );

        this._ensureInhibitor();
    }

    _stop() {
        console.log('VoiceToText: _stop called');
        if (!this._recording) return;

        if (!this._proxy) {
            console.log('VoiceToText: D-Bus proxy not available');
            this._setIdle();
            return;
        }

        this._indicator.setProcessing();
        this._audioLevelWidget?.hide();

        this._proxy.StopRecordingAsync().then(
            () => console.log('VoiceToText: StopRecording called via D-Bus'),
            e => {
                console.error(
                    'VoiceToText: D-Bus StopRecording failed:',
                    e.message
                );
                this._setIdle();
            }
        );
    }

    _ensureInhibitor() {
        if (this._inhibitCookie !== 0) return;
        if (!this._settings.get_boolean('inhibit-sleep')) return;
        if (!this._recording) return;

        this._sessionManager
            .InhibitAsync(
                'voice-to-text',
                0,
                'Voice recording in progress',
                12 // INHIBIT_SUSPEND | INHIBIT_IDLE (per InhibitedActions=12)
            )
            .then(
                cookie => {
                    // Race guard: only commit cookie if still recording and enabled
                    if (!this._recording || this._inhibitCookie !== 0) {
                        // Recording stopped or inhibitor already acquired;
                        // release the new cookie immediately
                        this._sessionManager.UninhibitAsync(cookie);
                        return;
                    }
                    this._inhibitCookie = cookie;
                    console.log(
                        `VoiceToText: sleep inhibitor acquired, cookie=${
                            this._inhibitCookie
                        }`
                    );
                },
                e => {
                    console.error(
                        'VoiceToText: failed to acquire sleep inhibitor:',
                        e.message
                    );
                }
            );
    }

    _releaseInhibitor() {
        if (this._inhibitCookie === 0) return;
        this._sessionManager.UninhibitAsync(this._inhibitCookie).then(
            () => {
                console.log(
                    `VoiceToText: sleep inhibitor released, cookie=${
                        this._inhibitCookie
                    }`
                );
            },
            e => {
                console.error(
                    'VoiceToText: failed to release sleep inhibitor:',
                    e.message
                );
            }
        );
        this._inhibitCookie = 0;
    }

    _setIdle() {
        this._releaseInhibitor();
        this._recording = false;
        this._audioLevelWidget?.hide();
        this._indicator?.setRecording(false);
    }

    _openPreferences() {
        console.log('VoiceToText: opening preferences dialog');
        try {
            const launcher = new Gio.SubprocessLauncher();
            launcher.spawnv(['gnome-extensions', 'prefs', this.uuid]);
        } catch (e) {
            console.error('VoiceToText: failed to open preferences:', e);
            this._showNotification(`Failed to open preferences: ${e.message}`);
        }
    }

    _showNotification(message) {
        const systemSource = MessageTray.getSystemSource();
        const notification = new MessageTray.Notification({
            source: systemSource,
            title: 'Voice to Text',
            body: message,
            iconName: 'audio-input-microphone-symbolic',
        });
        systemSource.addNotification(notification);
    }
}
