import Gio from 'gi://Gio';
import {
    Extension,
    gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';
import {VoiceIndicator} from './indicator.js';
import {registerHotkey, unregisterHotkey} from './hotkey.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {AudioLevelWidget} from './audio-level-widget.js';
import {TypeTextService} from './type-text-service.js';

const VoiceToTextIface = `
<node>
  <interface name="com.happytomatoe.VoiceToText">
    <method name="StartRecording">
      <arg type="s" name="config" direction="in"/>
    </method>
    <method name="StopRecording"/>
    <method name="CancelRecording"/>
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
        this._showNotification('VoiceToText: enable() called');
        this._settings = this.getSettings(
            'org.gnome.shell.extensions.voice-to-text'
        );
        this._indicator = new VoiceIndicator();
        this._proxy = null;
        this._recording = false;
        this._hotkeySignalId = null;
        this._profilingSignalId = null;
        this._signalIds = [];
        this._profiling = this._settings.get_boolean('profiling');
        const showAudioLevel = this._settings.get_boolean(
            'show-audio-level-widget'
        );
        this._audioLevelWidget = showAudioLevel ? new AudioLevelWidget() : null;
        if (this._audioLevelWidget) {
            this._audioLevelWidget.onCancel = () => this._cancel();
        }
        this._typeTextService = new TypeTextService();
        this._typeTextService.enable();
        this._indicator.onStart = () => this._start();
        this._indicator.onStop = () => this._stop();
        this._indicator.onConfigure = () => this._openPreferences();

        // @ts-expect-error
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._registerHotkey();

        this._hotkeySignalId = this._settings.connect('changed::hotkey', () => {
            this._registerHotkey();
        });
        this._audioLevelWidgetSignalId = this._settings.connect(
            'changed::show-audio-level-widget',
            () => {
                const enabled = this._settings.get_boolean(
                    'show-audio-level-widget'
                );
                if (enabled && !this._audioLevelWidget) {
                    this._audioLevelWidget = new AudioLevelWidget();
                    this._audioLevelWidget.onCancel = () => this._cancel();
                    if (this._recording) this._audioLevelWidget.show();
                } else if (!enabled && this._audioLevelWidget) {
                    this._audioLevelWidget.destroy();
                    this._audioLevelWidget = null;
                }
            }
        );
        this._profilingSignalId = this._settings.connect(
            'changed::profiling',
            () => {
                this._profiling = this._settings.get_boolean('profiling');
            }
        );
        this._signalIds.push(this._profilingSignalId);

        this._inhibitCookie = 0;
        // @ts-expect-error
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
        if (this._profilingSignalId) {
            this._settings.disconnect(this._profilingSignalId);
            this._profilingSignalId = null;
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
        } catch (e) {
            this._showNotification('Voice-to-Text failed to register hotkey');
            console.error('VoiceToText: failed to register hotkey:', e.message);
        }
    }

    _unregisterHotkey() {
        try {
            unregisterHotkey('hotkey');
        } catch (e) {
            this._showNotification('Voice-to-Text failed to register hotkey');
            console.error(
                'voicetotext: failed to unregister hotkey:',
                e.message
            );
        }
    }

    _connectDBus() {
        try {
            // @ts-expect-error - makeProxyWrapper returns a constructor but types don't reflect this
            this._proxy = new VoiceToTextProxy(
                Gio.DBus.session,
                'com.happytomatoe.VoiceToText',
                '/com/happytomatoe/VoiceToText'
            );

            this._signalIds = [];

            const stateId = this._proxy.connectSignal(
                'StateChanged',
                (_, __, [state]) => {
                    const elapsed = this._startTime
                        ? Date.now() - this._startTime
                        : 0;
                    if (this._profiling) {
                        console.log(`[VoiceToText] [PROFIL] state changed to '${state}', elapsed: ${elapsed}ms`);
                    }
                    if (state === 'recording') {
                        this._indicator?.setRecordingActive();
                        this._audioLevelWidget?.show();
                        if (this._profiling) {
                            console.log(`[VoiceToText] [PROFIL] user can speak now, total elapsed: ${elapsed}ms`);
                        }
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
                (_, __, [level]) => {
                    this._audioLevelWidget?.updateLevel(level);
                }
            );
            this._signalIds.push(levelId);

            const errorId = this._proxy.connectSignal(
                'Error',
                (_, __, [msg]) => {
                    console.error('VoiceToText: error:', msg);
                    this._showNotification(`Transcription failed: ${msg}`);
                }
            );
            this._signalIds.push(errorId);

            // Sync state on (re)enable — engine may already be recording
            const proxyRef = this._proxy;
            this._proxy
                .GetStatusAsync()
                .then(state => {
                    // Guard: extension may have been disabled or re-enabled while promise was pending
                    if (
                        this._proxy === proxyRef &&
                        (state === 'recording' || state === 'processing')
                    ) {
                        this._recording = true;
                        if (state === 'processing') {
                            this._indicator?.setProcessing();
                        } else {
                            this._indicator?.setRecordingActive();
                        }
                        this._ensureInhibitor();
                    }
                })
                .catch(err =>
                    console.error('VoiceToText: initial GetStatus failed:', err)
                ); // best-effort init sync
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
        this._startTime = Date.now();
        if (this._recording) return;

        if (!this._proxy) {
            this._showNotification('Voice-to-Text D-Bus service not available');
            return;
        }

        if (!this._indicator) {
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
        };

        this._proxy
            .StartRecordingAsync(JSON.stringify(config))
            .then(() => {
                if (this._profiling) {
                    console.log(`[VoiceToText] [PROFIL] StartRecording sent via D-Bus, elapsed: ${Date.now() - this._startTime}ms`);
                }
            })
            .catch(e => {
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
            });

        this._ensureInhibitor();
    }

    _stop() {
        if (!this._recording) return;

        if (!this._proxy) {
            this._setIdle();
            return;
        }

        this._indicator.setProcessing();
        this._audioLevelWidget?.hide();

        this._proxy.StopRecordingAsync().catch(e => {
            console.error(
                'VoiceToText: D-Bus StopRecording failed:',
                e.message
            );
            this._setIdle();
        });
    }

    _cancel() {
        if (!this._recording) return;

        if (!this._proxy) {
            this._setIdle();
            return;
        }

        this._audioLevelWidget?.hide();

        this._proxy.CancelRecordingAsync().catch(e => {
            console.error(
                'VoiceToText: D-Bus CancelRecording failed:',
                e.message
            );
            this._setIdle();
        });
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
            .then(cookie => {
                if (this._recording && this._inhibitCookie === 0) {
                    this._inhibitCookie = cookie;
                } else {
                    // Race guard: recording stopped or inhibitor already acquired;
                    // release the new cookie immediately
                    this._sessionManager.UninhibitAsync(cookie);
                }
            })
            .catch(e => {
                console.error(
                    'VoiceToText: failed to acquire sleep inhibitor:',
                    e.message
                );
            });
    }

    _releaseInhibitor() {
        if (this._inhibitCookie === 0) return;
        this._sessionManager
            .UninhibitAsync(this._inhibitCookie)
            .then(() =>
                console.log(`[VoiceToText] sleep inhibitor released, cookie=${this._inhibitCookie}`)
            )
            .catch(e => {
                console.error(
                    'VoiceToText: failed to release sleep inhibitor:',
                    e.message
                );
            });
        this._inhibitCookie = 0;
    }

    _setIdle() {
        this._releaseInhibitor();
        this._recording = false;
        this._audioLevelWidget?.hide();
        this._indicator?.setRecording(false);
    }

    _openPreferences() {
        try {
            const launcher = new Gio.SubprocessLauncher();
            // @ts-expect-error
            launcher.spawnv(['gnome-extensions', 'prefs', this.uuid]);
        } catch (e) {
            console.error('VoiceToText: failed to open preferences:', e);
            this._showNotification(`Failed to open preferences: ${e.message}`);
        }
    }
    //TODO: Move into utils file.
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

//TODO: Refactor this file, it's too large.
