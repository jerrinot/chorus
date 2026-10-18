import Gio from 'gi://Gio';

const UUID = 'sonos-groups@jara.local';
const action = ARGV[0];
const settings = new Gio.Settings({schemaId: 'org.gnome.shell'});
const enabled = settings.get_strv('enabled-extensions');

if (action === 'enable' && !enabled.includes(UUID))
    enabled.push(UUID);
else if (action === 'disable' && enabled.includes(UUID))
    enabled.splice(enabled.indexOf(UUID), 1);
else if (action !== 'enable' && action !== 'disable')
    throw new Error('usage: set-enabled.js enable|disable');

if (!settings.set_strv('enabled-extensions', enabled))
    throw new Error('GNOME rejected the enabled extension list');
