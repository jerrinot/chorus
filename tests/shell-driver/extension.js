import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function pickerTopology() {
    const kitchen = {
        id: 'kitchen',
        name: 'Kitchen',
        coordinator: true,
    };
    const office = {
        id: 'office',
        name: 'Office',
        coordinator: false,
    };
    const bedroom = {
        id: 'bedroom',
        name: 'Bedroom',
        coordinator: true,
    };
    const kitchenGroup = {
        id: 'kitchen-group',
        coordinatorId: kitchen.id,
        members: [kitchen, office],
    };
    const bedroomGroup = {
        id: 'bedroom-group',
        coordinatorId: bedroom.id,
        members: [bedroom],
    };
    const groups = [kitchenGroup, bedroomGroup];
    const speakers = groups.flatMap(group =>
        group.members.map(room => ({...room, group})));
    return {groups, speakers};
}

export default class ChorusShellTestDriver extends Extension {
    enable() {
        this._runMenuViewTest().then(() => {
            GLib.file_set_contents(GLib.getenv('CHORUS_TEST_RESULT'), 'pass\n');
        }).catch(error => {
            GLib.file_set_contents(
                GLib.getenv('CHORUS_TEST_RESULT'),
                `fail: ${error.stack ?? error.message}\n`);
            logError(error, 'Chorus menu view test failed');
        });

        this._openId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            250,
            () => {
                this._openId = 0;
                Main.panel.statusArea.quickSettings.menu.open();
                return GLib.SOURCE_REMOVE;
            });
    }

    async _runMenuViewTest() {
        const projectDir = GLib.getenv('CHORUS_TEST_PROJECT_DIR');
        const moduleUrl = GLib.filename_to_uri(
            `${projectDir}/menuView.js`, null);
        const {ChorusMenuView} = await import(moduleUrl);
        const items = [];
        const menu = {
            addMenuItem(item) {
                items.push(item);
            },
            setHeader() {
            },
        };
        const noOp = () => {};
        const view = new ChorusMenuView(menu, {
            showRoomPicker: noOp,
            showOverview: noOp,
            toggleRoom: noOp,
            playEverywhere: noOp,
            keepOnly: noOp,
            retry: noOp,
        });

        try {
            view.render(pickerTopology(), 'kitchen', () => false);
            for (const item of [view._everywhereItem, view._onlyItem]) {
                assert(item.visible, 'footer action must be visible in fixture');
                assert(item.sensitive, 'footer action must start enabled');

                view.startBusy(item);
                assert(!item.sensitive,
                    'the active footer action must be disabled while busy');
                view.showBusy(item, 'Working…');
                assert(!view._footerSection.sensitive,
                    'the footer must be disabled while progress is shown');
                view.clearBusy();

                assert(item.sensitive,
                    'the active footer action must recover after completion');
                assert(view._footerSection.sensitive,
                    'the footer must recover after completion');
            }
        } finally {
            for (const item of items)
                item.destroy();
        }
    }

    disable() {
        if (this._openId)
            GLib.source_remove(this._openId);
        this._openId = 0;
    }
}
