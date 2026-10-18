// Adds or removes an extension UUID in org.gnome.shell enabled-extensions.
//
// Unlike `gnome-extensions enable`, this does not require the running Shell
// to know the extension yet: the Shell applies the setting immediately if the
// extension is loaded, and at the next login otherwise.

import Gio from 'gi://Gio';

const [action, uuid] = ARGV;
if (!['enable', 'disable'].includes(action) || !uuid)
    throw new Error('usage: set-enabled.js enable|disable UUID');

const settings = new Gio.Settings({schemaId: 'org.gnome.shell'});
const enabled = settings.get_strv('enabled-extensions')
    .filter(entry => entry !== uuid);
if (action === 'enable')
    enabled.push(uuid);

if (!settings.set_strv('enabled-extensions', enabled))
    throw new Error('GNOME rejected the enabled extension list');
Gio.Settings.sync();
