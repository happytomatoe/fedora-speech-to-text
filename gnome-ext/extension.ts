import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {VoiceIndicator} from './indicator.js';
import {registerHotkey, unregisterHotkey} from './hotkey.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

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

const VoiceToTextProxy = Gio.DBusProxy.makeProxyWrapper(VoiceToTextIface) as unknown as new (...args: any[]) => any;

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

const SessionManagerProxy = Gio.DBusProxy.makeProxyWrapper(SessionManagerIface) as unknown as new (...args: any[]) => any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default class VoiceToTextExtension extends Extension {
    private _settings: any = null;
    private _indicator: any = null;
    private _proxy: any = null;
    private _recording = false;
    private _hotkeySignalId: number | null = null;
    private _signalIds: number[] = [];
    private _inhibitCookie = 0;
    private _sessionManager: any = null;

    enable() {
        this._settings = this.getSettings(
            'org.gnome.shell.extensions.voice-to-text'
        );
        this._indicator = new VoiceIndicator();
        this._proxy = null;
        this._recording = false;
        this._hotkeySignalId = null;
        this._signalIds = [];

        this._indicator.onStart = () => this._start();
        this._indicator.onStop = () => this._stop();
        this._indicator.onConfigure = () => this._openPreferences();

        Main.panel.addToStatusArea(this.metadata.uuid, this._indicator, 0, 'right');
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

        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        this._recording = false;
    }

    private _toggle(): void {
        console.log('VoiceToText: _toggle called');
        if (this._recording) {
            this._stop();
        } else {
            this._start();
        }
    }

    private _registerHotkey(): void {
        this._unregisterHotkey();

        try {
            registerHotkey('hotkey', this._settings, () => this._toggle());
            console.log('VoiceToText: hotkey registered');
        } catch (e) {
            console.error('VoiceToText: failed to register hotkey:', e instanceof Error ? e.message : e);
        }
    }

    private _unregisterHotkey(): void {
        try {
            unregisterHotkey('hotkey');
            console.log('VoiceToText: hotkey unregistered');
        } catch (e) {
            console.error(
                'VoiceToText: failed to unregister hotkey:',
                e instanceof Error ? e.message : e
            );
        }
    }

    private _connectDBus(): void {
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
                (_proxy: any, _name: string, [state]: [string]) => {
                    console.log('VoiceToText: state changed to', state);
                    if (state === 'recording') {
                        this._indicator?.setRecordingActive();
                    } else if (state === 'processing') {
                        this._indicator?.setProcessing();
                    } else if (state === 'idle') {
                        this._indicator?.setRecording(false);
                        this._recording = false;
                        this._releaseInhibitor();
                    }
                }
            );
            this._signalIds.push(stateId);

            const levelId = this._proxy.connectSignal(
                'AudioLevel',
                (_proxy: any, _name: string, [level]: [number]) => {
                    this._indicator?.updateLevel(level);
                }
            );
            this._signalIds.push(levelId);

            const errorId = this._proxy.connectSignal(
                'Error',
                (_proxy: any, _name: string, [msg]: [string]) => {
                    console.log('VoiceToText: error:', msg);
                    this._showNotification(`Transcription failed: ${msg}`);
                }
            );
            this._signalIds.push(errorId);

            console.log('VoiceToText: D-Bus proxy connected');

            // Sync state on (re)enable — engine may already be recording
            this._proxy.GetStatusAsync().then(
                (state: string) => {
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
                e instanceof Error ? e.message : e
            );
            this._showNotification('Voice-to-Text D-Bus service not running. ');
        }
    }

    private _disconnectDBusSignals(): void {
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

    private _start(): void {
        console.log('VoiceToText: _start called');
        if (this._recording) return;

        if (!this._proxy) {
            console.log('VoiceToText: D-Bus proxy not available');
            this._showNotification('Voice-to-Text D-Bus service not available');
            return;
        }

        this._indicator?.setProcessing();
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
        };

        this._proxy.StartRecordingAsync(JSON.stringify(config)).then(
            () => console.log('VoiceToText: StartRecording called via D-Bus'),
            (e: unknown) => {
                console.error(
                    'VoiceToText: D-Bus StartRecording failed:',
                    e instanceof Error ? e.message : e
                );
                this._showNotification(
                    `Failed to start recording: ${e instanceof Error ? e.message : e}`
                );
                this._recording = false;
                this._releaseInhibitor();
                this._indicator?.setRecording(false);
            }
        );

        this._ensureInhibitor();
        if (this._settings.get_boolean('show-recording-notification')) {
            this._showNotification('Recording...');
        }
    }

    private _stop(): void {
        console.log('VoiceToText: _stop called');
        if (!this._recording) return;

        if (!this._proxy) {
            console.log('VoiceToText: D-Bus proxy not available');
            this._setIdle();
            return;
        }

        this._indicator?.setProcessing();

        this._proxy.StopRecordingAsync().then(
            () => console.log('VoiceToText: StopRecording called via D-Bus'),
            (e: unknown) => {
                console.error(
                    'VoiceToText: D-Bus StopRecording failed:',
                    e instanceof Error ? e.message : e
                );
                this._setIdle();
            }
        );
    }

    private _ensureInhibitor(): void {
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
                (cookie: number) => {
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
                (e: unknown) => {
                    console.error(
                        'VoiceToText: failed to acquire sleep inhibitor:',
                        e instanceof Error ? e.message : e
                    );
                }
            );
    }

    private _releaseInhibitor(): void {
        if (this._inhibitCookie === 0) return;
        this._sessionManager.UninhibitAsync(this._inhibitCookie).then(
            () => {
                console.log(
                    `VoiceToText: sleep inhibitor released, cookie=${
                        this._inhibitCookie
                    }`
                );
            },
            (e: unknown) => {
                console.error(
                    'VoiceToText: failed to release sleep inhibitor:',
                    e instanceof Error ? e.message : e
                );
            }
        );
        this._inhibitCookie = 0;
    }

    private _setIdle(): void {
        this._releaseInhibitor();
        this._recording = false;
        this._indicator?.setRecording(false);
    }

    private _openPreferences(): void {
        console.log('VoiceToText: opening preferences dialog');
        try {
            const launcher = new Gio.SubprocessLauncher();
            launcher.spawnv(['gnome-extensions', 'prefs', this.metadata.uuid]);
        } catch (e) {
            console.error('VoiceToText: failed to open preferences:', e instanceof Error ? e.message : e);
            this._showNotification(`Failed to open preferences: ${e instanceof Error ? e.message : e}`);
        }
    }

    private _showNotification(message: string): void {
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
