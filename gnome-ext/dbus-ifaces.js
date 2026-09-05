// @ts-check
/**
 * D-Bus interface XML definitions and proxy wrappers for the extension.
 */

import Gio from 'gi://Gio';

export const VoiceToTextIface = `
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
    <signal name="OpenPrefsRequested">
      <arg type="s" name="kind"/>
    </signal>
  </interface>
</node>`;

export const VoiceToTextProxy = Gio.DBusProxy.makeProxyWrapper(VoiceToTextIface);

export const SessionManagerIface =
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

export const SessionManagerProxy = Gio.DBusProxy.makeProxyWrapper(SessionManagerIface);
