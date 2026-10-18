import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class ChorusShellTestDriver extends Extension {
    enable() {
        this._openId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            250,
            () => {
                this._openId = 0;
                Main.panel.statusArea.quickSettings.menu.open();
                return GLib.SOURCE_REMOVE;
            });
    }

    disable() {
        if (this._openId)
            GLib.source_remove(this._openId);
        this._openId = 0;
    }
}
