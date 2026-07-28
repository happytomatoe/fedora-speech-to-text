import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {VoiceIndicator} from './indicator.js';
import {registerHotkey, unregisterHotkey} from './hotkey.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {AudioLevelWidget} from './audio-level-widget.js';

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
        this._audioLevelWidget = this._settings.get_boolean(
            'show-audio-level-widget'
        )
            ? new AudioLevelWidget()
            : null;

        this._indicator.onStart = () => this._start();
        this._indicator.onStop = () => this._stop();
        this._indicator.onConfigure = () => this._openPreferences();

        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._registerHotkey();

        // Listen for hotkey changes
        this._hotkeySignalId = this._settings.connect('changed::hotkey', () => {
            this._registerHotkey();
        });

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

        this._disconnectDBusSignals();

        if (this._recording) {
            this._stop();
        }

        this._releaseInhibitor();
        this._sessionManager = null;
        this._proxy = null;

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
                        this._indicator.setRecordingActive();
                    } else if (state === 'processing') {
                        this._indicator.setProcessing();
                    } else if (state === 'idle') {
                        this._indicator.setRecording(false);
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
            this._proxy.GetStatusAsync().then(
                state => {
                    console.log('VoiceToText: initial state:', state);
                    if (state === 'recording' || state === 'processing') {
                        this._recording = true;
                        if (state === 'processing') {
                            this._indicator.setProcessing();
                        } else {
                            this._indicator.setRecordingActive();
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

        this._indicator.setProcessing();
        this._audioLevelWidget?.show();
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
