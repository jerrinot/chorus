import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {
    gettext as _,
    ngettext,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import {coordinatorOf} from './sonos.js';

export function groupLabel(group) {
    const names = group.members.map(member => member.name);
    if (names.length <= 2)
        return names.join(' + ');

    return _('%s and %d more')
        .replace('%s', names[0])
        .replace('%d', names.length - 1);
}

function trailingLabel(item) {
    const label = new St.Label({
        style_class: 'dim-label chorus-room-status',
        y_align: Clutter.ActorAlign.CENTER,
    });
    item.label.x_expand = true;
    item.add_child(label);
    return label;
}

// Room selection is a multi-step operation, so activating an item should not
// close Quick Settings.
class StayOpenMenuSection extends PopupMenu.PopupMenuSection {
    itemActivated() {
    }
}

export class ChorusMenuView {
    constructor(menu, actions) {
        this._menu = menu;
        this._actions = actions;
        this._groupRows = new Map();
        this._roomRows = new Map();
        this._busyLabels = new Map();
        this._orders = new Map();
        this._busyLabel = null;
        this._busyItem = null;
        this._busyItemSensitive = true;

        this._overviewSection = new StayOpenMenuSection();
        this._pickerSection = new StayOpenMenuSection();
        this._placeholder = new PopupMenu.PopupMenuItem(_('Finding rooms…'), {
            reactive: false,
            can_focus: false,
        });
        this._footerSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._footerSection = new StayOpenMenuSection();

        menu.addMenuItem(this._overviewSection);
        menu.addMenuItem(this._pickerSection);
        menu.addMenuItem(this._placeholder);
        menu.addMenuItem(this._footerSeparator);
        menu.addMenuItem(this._footerSection);

        this._overviewHeadings = [
            new PopupMenu.PopupSeparatorMenuItem(_('Playing')),
            new PopupMenu.PopupSeparatorMenuItem(_('Together')),
            new PopupMenu.PopupSeparatorMenuItem(_('Rooms')),
        ];
        for (const heading of this._overviewHeadings)
            this._overviewSection.addMenuItem(heading);

        this._backItem = new PopupMenu.PopupImageMenuItem(
            _('Sonos'), 'go-previous-symbolic');
        this._backItem.connect('activate', () => this._actions.showOverview());
        this._roomHeading = new PopupMenu.PopupSeparatorMenuItem(_('Rooms'));
        this._pickerSection.addMenuItem(this._backItem);
        this._pickerSection.addMenuItem(this._roomHeading);

        this._retryItem = this._footerSection.addAction(
            _('Try Again'), () => this._actions.retry());
        this._everywhereItem = this._footerSection.addAction(
            _('Everywhere'),
            () => this._actions.playEverywhere(this._everywhereItem));
        this._onlyItem = this._footerSection.addAction(
            _('Only this room'), () => this._actions.keepOnly(this._onlyItem));

        this.showLoading();
    }

    showLoading() {
        this.clearBusy();
        this._showSections(false, false, false);
        this._placeholder.label.text = _('Finding Sonos rooms…');
        this._placeholder.visible = true;
        this._footerSeparator.visible = false;
    }

    showError() {
        this.clearBusy();
        this._menu.setHeader(
            'audio-speakers-symbolic',
            _('Sonos'),
            _('Rooms are unavailable'));
        this._showSections(false, false, true);
        this._placeholder.label.text =
            _('Check that Sonos and Avahi are available');
        this._placeholder.visible = true;
        this._retryItem.visible = true;
        this._everywhereItem.visible = false;
        this._onlyItem.visible = false;
        this._footerSeparator.visible = true;
    }

    render(topology, sourceRoomId, isGroupPlaying) {
        this._placeholder.visible = topology.speakers.length === 0;
        this._placeholder.label.text = _('No Sonos rooms found');

        const source = topology.speakers.find(room => room.id === sourceRoomId);
        if (source)
            this._renderRoomPicker(topology, source, isGroupPlaying);
        else
            this._renderOverview(topology, isGroupPlaying);
    }

    startBusy(item) {
        this.clearBusy();
        this._busyItem = item;
        if (item) {
            this._busyItemSensitive = item.sensitive;
            item.sensitive = false;
        }
    }

    showBusy(item, text) {
        this._setSectionsSensitive(false);

        if (!item)
            return;

        let label = this._busyLabels.get(item);
        if (!label) {
            label = trailingLabel(item);
            this._busyLabels.set(item, label);
        }
        label.text = text;
        label.visible = true;
        this._busyLabel = label;
    }

    setRoomSelected(item, selected) {
        item.setOrnament(selected
            ? PopupMenu.Ornament.CHECK
            : PopupMenu.Ornament.NONE);
    }

    clearBusy() {
        if (this._busyLabel)
            this._busyLabel.visible = false;
        this._busyLabel = null;
        if (this._busyItem)
            this._busyItem.sensitive = this._busyItemSensitive;
        this._busyItem = null;
        this._setSectionsSensitive(true);
    }

    _setSectionsSensitive(sensitive) {
        this._overviewSection.sensitive = sensitive;
        this._pickerSection.sensitive = sensitive;
        this._footerSection.sensitive = sensitive;
    }

    _showSections(overview, picker, footer) {
        this._overviewSection.actor.visible = overview;
        this._pickerSection.actor.visible = picker;
        this._footerSection.actor.visible = footer;
    }

    _renderOverview(topology, isGroupPlaying) {
        const playing = topology.groups.filter(isGroupPlaying);
        const playingIds = new Set(playing.map(group => group.id));
        const together = topology.groups.filter(group =>
            !playingIds.has(group.id) && group.members.length > 1);
        const rooms = topology.groups.filter(group =>
            !playingIds.has(group.id) && group.members.length === 1);

        let instruction = _('Choose where to play');
        if (playing.length > 1)
            instruction = _('Choose the sound to extend');
        else if (playing.length === 1)
            instruction = _('Choose another sound');

        this._menu.setHeader(
            'audio-speakers-symbolic', _('Sonos'), instruction);
        this._showSections(true, false, false);
        this._footerSeparator.visible = false;

        const categories = [
            {
                heading: this._overviewHeadings[0],
                title: _('Playing'),
                groups: playing,
            },
            {
                heading: this._overviewHeadings[1],
                title: playing.length > 0 ? _('Other Groups') : _('Together'),
                groups: together,
            },
            {
                heading: this._overviewHeadings[2],
                title: playing.length > 0 ? _('Other Rooms') : _('Rooms'),
                groups: rooms,
            },
        ];
        const visibleItems = [];
        const visibleRows = new Set();

        for (const {heading, title, groups} of categories) {
            heading.label.text = title;
            heading.visible = groups.length > 0;
            if (groups.length > 0)
                visibleItems.push(heading);

            for (const group of groups) {
                const row = this._groupRow(group);
                this._updateGroupRow(row, group, isGroupPlaying(group));
                visibleRows.add(row);
                visibleItems.push(row.item);
            }
        }

        for (const row of this._groupRows.values())
            row.item.visible = visibleRows.has(row);
        this._orderItems(
            this._overviewSection,
            visibleItems,
            [
                ...this._overviewHeadings,
                ...[...this._groupRows.values()].map(row => row.item),
            ]);
    }

    _groupRow(group) {
        const key = coordinatorOf(group).id;
        let row = this._groupRows.get(key);
        if (row)
            return row;

        const item = new PopupMenu.PopupImageMenuItem(
            groupLabel(group), 'audio-speakers-symbolic');
        const roomCount = trailingLabel(item);
        item.add_child(PopupMenu.arrowIcon(St.Side.RIGHT));
        row = {item, roomCount, sourceRoomId: key};
        item.connect('activate', () =>
            this._actions.showRoomPicker(row.sourceRoomId));
        this._overviewSection.addMenuItem(item);
        this._groupRows.set(key, row);
        return row;
    }

    _updateGroupRow(row, group, playing) {
        row.sourceRoomId = coordinatorOf(group).id;
        row.item.label.text = groupLabel(group);
        row.item.setIcon(playing
            ? 'media-playback-start-symbolic'
            : group.members.length > 1
                ? 'emblem-shared-symbolic'
                : 'audio-speakers-symbolic');
        row.roomCount.text = ngettext(
            '%d room', '%d rooms', group.members.length)
            .replace('%d', group.members.length);
        row.roomCount.visible = group.members.length > 1;
    }

    _renderRoomPicker(topology, source, isGroupPlaying) {
        const targetGroup = source.group;
        this._menu.setHeader(
            'audio-speakers-symbolic',
            source.name,
            isGroupPlaying(targetGroup)
                ? _('Playing in these rooms')
                : _('Choose rooms to play together'));
        this._showSections(false, true, true);

        const visibleRows = new Set();
        const visibleItems = [this._backItem, this._roomHeading];
        for (const room of topology.speakers) {
            const row = this._roomRow(room);
            const selected = room.group.id === targetGroup.id;
            row.selected = selected;
            row.item.label.text = room.name;
            row.item.setOrnament(selected
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
            row.item.sensitive = !(selected && targetGroup.members.length === 1);
            row.item.visible = true;
            visibleRows.add(row);
            visibleItems.push(row.item);
        }

        for (const row of this._roomRows.values())
            row.item.visible = visibleRows.has(row);
        this._orderItems(
            this._pickerSection,
            visibleItems,
            [this._backItem, this._roomHeading,
                ...[...this._roomRows.values()].map(row => row.item)]);

        const canPlayEverywhere =
            targetGroup.members.length < topology.speakers.length;
        const canKeepOnlySource = targetGroup.members.length > 1;
        this._retryItem.visible = false;
        this._everywhereItem.visible = canPlayEverywhere;
        this._onlyItem.visible = canKeepOnlySource;
        this._onlyItem.label.text = _('Only %s').replace('%s', source.name);
        this._footerSeparator.visible = canPlayEverywhere || canKeepOnlySource;
    }

    _roomRow(room) {
        let row = this._roomRows.get(room.id);
        if (row)
            return row;

        const item = new PopupMenu.PopupMenuItem(room.name);
        item.accessible_role = Atk.Role.CHECK_MENU_ITEM;
        row = {item, roomId: room.id, selected: false};
        item.connect('activate', () =>
            this._actions.toggleRoom(row.roomId, !row.selected, item));
        this._pickerSection.addMenuItem(item);
        this._roomRows.set(room.id, row);
        return row;
    }

    _orderItems(section, visibleItems, allItems) {
        const visible = new Set(visibleItems);
        const ordered = [
            ...visibleItems,
            ...allItems.filter(item => !visible.has(item)),
        ];
        const previous = this._orders.get(section);
        if (previous?.length === ordered.length &&
            previous.every((item, index) => item === ordered[index]))
            return;

        for (const item of ordered)
            section.moveMenuItem(item, section.numMenuItems);
        this._orders.set(section, ordered);
    }
}
