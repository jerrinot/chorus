import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {
    Extension,
    gettext as _,
    ngettext,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SonosClient} from './sonos.js';
import {RefreshScheduler, ViewMode} from './state.js';

const BACKGROUND_REFRESH_INTERVAL_SECONDS = 60;
const VISIBLE_REFRESH_INTERVAL_SECONDS = 5;
const PROGRESS_DELAY_MS = 300;
const ACTIVE_TRANSPORT_STATES = new Set(['PLAYING', 'TRANSITIONING']);

function groupLabel(group) {
    const names = group.members.map(member => member.name);
    if (names.length <= 2)
        return names.join(' + ');

    return _('%s and %d more')
        .replace('%s', names[0])
        .replace('%d', names.length - 1);
}

function coordinatorOf(group) {
    return group.members.find(member => member.coordinator) ?? group.members[0];
}

// PopupMenu normally closes after an activation. This is a destination
// picker, so people should be able to check several rooms in one visit.
class StayOpenMenuSection extends PopupMenu.PopupMenuSection {
    itemActivated() {
    }
}

const SonosToggle = GObject.registerClass(
class SonosToggle extends QuickSettings.QuickMenuToggle {
    _init(client, logger, stateChanged) {
        super._init({
            title: _('Sonos'),
            subtitle: _('Finding rooms…'),
            iconName: 'audio-speakers-symbolic',
            menuButtonAccessibleName: _('Open Sonos'),
            toggleMode: false,
        });

        this._client = client;
        this._logger = logger;
        this._stateChanged = stateChanged;
        this._topology = null;
        this._playback = {
            states: new Map(),
            queuedTopology: null,
            promise: null,
        };
        this._view = {
            mode: ViewMode.AUTOMATIC,
            sourceRoomId: null,
        };
        this._menuSignature = null;
        this._topologyGeneration = 0;
        this._operation = null;
        this._activeMenuItem = null;
        this._viewTransitionId = 0;
        this._visibleRefreshTimer = null;
        this._progressTimer = 0;
        this._destroyed = false;
        this._refreshScheduler = new RefreshScheduler(
            () => this._refreshTopology(),
            async () => {
                if (this._operation)
                    await this._operation;
            });

        this.menu.setHeader(
            'audio-speakers-symbolic',
            _('Sonos'),
            _('Finding rooms…'));

        this._contentSection = new StayOpenMenuSection();
        this.menu.addMenuItem(this._contentSection);

        this._placeholder = new PopupMenu.PopupMenuItem(_('Finding rooms…'), {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._placeholder);

        this._footerSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._footerSeparator);

        this._footerSection = new StayOpenMenuSection();
        this.menu.addMenuItem(this._footerSection);

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._startVisibleRefresh();
                if (!this._operation) {
                    this._setView(ViewMode.AUTOMATIC);
                    this._selectOnlyPlayingGroup();
                    if (this._topology)
                        this._renderTopology(true);
                }
                this.refresh(true).catch(error =>
                    this._reportError(error, _('Could not update Sonos rooms')));
            } else {
                this._stopVisibleRefresh();
                if (!this._operation)
                    this._setView(ViewMode.AUTOMATIC);
            }
        });
        this.connect('clicked', () => this.menu.open());

        this._renderLoading();
    }

    destroy() {
        this._destroyed = true;
        this._stopVisibleRefresh();
        this._cancelViewTransition();
        this._clearProgress();
        this._deactivateMenuItem();
        super.destroy();
    }

    async refresh(force = false) {
        if (this._destroyed)
            return;

        return this._refreshScheduler.request(force);
    }

    async _refreshTopology() {
        const generation = this._topologyGeneration;
        try {
            const topology = await this._client.getTopology();
            if (this._destroyed || generation !== this._topologyGeneration)
                return;

            this._topology = topology;
            if (this._view.sourceRoomId && !topology.speakers.some(
                room => room.id === this._view.sourceRoomId))
                this._setView(ViewMode.AUTOMATIC);

            if (this.menu.isOpen)
                this._selectOnlyPlayingGroup();
            this._renderTopology();
            this._requestPlayback(topology);
        } catch (error) {
            if (this._destroyed || generation !== this._topologyGeneration)
                return;
            this._topology = null;
            this._playback.states.clear();
            this._setView(ViewMode.AUTOMATIC);
            this._renderError();
            throw error;
        }
    }

    _requestPlayback(topology) {
        this._playback.queuedTopology = topology;
        if (this._playback.promise || this._destroyed)
            return;

        const promise = this._loadPlayback();
        this._playback.promise = promise;
        promise.catch(error => this._logger.error(error)).finally(() => {
            if (this._playback.promise === promise)
                this._playback.promise = null;
            if (this._playback.queuedTopology && !this._destroyed)
                this._requestPlayback(this._playback.queuedTopology);
        });
    }

    async _loadPlayback() {
        while (!this._destroyed && this._playback.queuedTopology) {
            const topology = this._playback.queuedTopology;
            this._playback.queuedTopology = null;
            const states = await this._client.getPlaybackStates(topology);

            if (this._destroyed)
                return;
            if (this._topology !== topology)
                continue;

            this._playback.states = states;
            if (this.menu.isOpen)
                this._selectOnlyPlayingGroup();
            if (!this._operation)
                this._renderTopology();
        }
    }

    _isGroupPlaying(group) {
        return ACTIVE_TRANSPORT_STATES.has(
            this._playback.states.get(group.coordinatorId));
    }

    _playingGroups() {
        if (!this._topology)
            return [];
        return this._topology.groups.filter(group => this._isGroupPlaying(group));
    }

    _selectOnlyPlayingGroup() {
        if (!this._topology || this._view.mode !== ViewMode.AUTOMATIC)
            return;

        const playingGroups = this._playingGroups();
        if (playingGroups.length === 1) {
            this._setView(
                ViewMode.AUTOMATIC,
                coordinatorOf(playingGroups[0]).id);
        } else {
            this._setView(ViewMode.AUTOMATIC);
        }
    }

    _setView(mode, sourceRoomId = null) {
        this._view = {mode, sourceRoomId};
    }

    _startVisibleRefresh() {
        if (this._visibleRefreshTimer)
            return;

        this._visibleRefreshTimer = setInterval(() => {
            this.refresh().catch(error =>
                this._logger.debug(error.stack ?? error.message));
        }, VISIBLE_REFRESH_INTERVAL_SECONDS * 1000);
    }

    _stopVisibleRefresh() {
        if (!this._visibleRefreshTimer)
            return;

        clearInterval(this._visibleRefreshTimer);
        this._visibleRefreshTimer = null;
    }

    _renderLoading() {
        this._menuSignature = null;
        this.subtitle = _('Finding rooms…');
        this.reactive = false;
        this._contentSection.removeAll();
        this._footerSection.removeAll();
        this._placeholder.label.text = _('Finding Sonos rooms…');
        this._placeholder.visible = true;
        this._footerSeparator.visible = false;
        this._stateChanged(false);
    }

    _renderError() {
        this._menuSignature = null;
        this.subtitle = _('Unavailable');
        this.reactive = true;
        this.menu.setHeader(
            'audio-speakers-symbolic',
            _('Sonos'),
            _('Rooms are unavailable'));
        this._resetMenuSections();
        this._placeholder.label.text =
            _('Check that Sonos and Avahi are available');
        this._placeholder.visible = true;
        this._footerSeparator.visible = true;
        const retryItem = this._footerSection.addAction(_('Try Again'), () => {
            this.refresh(true).catch(refreshError =>
                this._reportError(
                    refreshError,
                    _('Could not update Sonos rooms')));
        });
        this._trackMenuItem(retryItem);
        this._stateChanged(false);
    }

    _renderTopology(forceMenu = false) {
        const {groups, speakers} = this._topology;
        const grouped = groups.filter(group => group.members.length > 1);
        const playing = this._playingGroups();

        this.reactive = true;
        if (playing.length === 1) {
            this.subtitle = groupLabel(playing[0]);
        } else if (playing.length > 1) {
            this.subtitle = ngettext(
                '%d sound playing',
                '%d sounds playing',
                playing.length).replace('%d', playing.length);
        } else if (grouped.length === 0) {
            const roomCount = ngettext(
                '%d room',
                '%d rooms',
                speakers.length).replace('%d', speakers.length);
            this.subtitle = `${roomCount} · ${_('All separate')}`;
        } else if (grouped.length === 1) {
            this.subtitle = groupLabel(grouped[0]);
        } else {
            this.subtitle = ngettext(
                '%d group',
                '%d groups',
                grouped.length).replace('%d', grouped.length);
        }

        this._placeholder.visible = speakers.length === 0;
        this._placeholder.label.text = _('No Sonos rooms found');

        if (forceMenu || this.menu.isOpen) {
            const signature = this._menuRenderSignature();
            if (forceMenu || signature !== this._menuSignature) {
                this._menuSignature = signature;
                if (this._view.sourceRoomId)
                    this._renderRoomPicker();
                else
                    this._renderOverview();
            }
        }

        this._stateChanged(grouped.length > 0);
    }

    _menuRenderSignature() {
        const groups = this._topology.groups.map(group => [
            group.id,
            group.coordinatorId,
            this._isGroupPlaying(group),
            group.members.map(member => [member.id, member.name]),
        ]);
        return JSON.stringify([
            this._view.mode,
            this._view.sourceRoomId,
            groups,
        ]);
    }

    _resetMenuSections() {
        this._deactivateMenuItem();
        this._contentSection.sensitive = true;
        this._footerSection.sensitive = true;
        this._contentSection.removeAll();
        this._footerSection.removeAll();
        this._footerSeparator.visible = false;
    }

    _renderOverview() {
        const {groups} = this._topology;
        const playing = groups.filter(group => this._isGroupPlaying(group));
        const playingIds = new Set(playing.map(group => group.id));
        const together = groups.filter(group =>
            !playingIds.has(group.id) && group.members.length > 1);
        const rooms = groups.filter(group =>
            !playingIds.has(group.id) && group.members.length === 1);

        let instruction = _('Choose where to play');
        if (playing.length > 1)
            instruction = _('Choose the sound to extend');
        else if (playing.length === 1)
            instruction = _('Choose another sound');

        this.menu.setHeader(
            'audio-speakers-symbolic',
            _('Sonos'),
            instruction);
        this._resetMenuSections();

        this._addGroupSection(_('Playing'), playing, true);
        this._addGroupSection(
            playing.length > 0 ? _('Other Groups') : _('Together'),
            together,
            false);
        this._addGroupSection(
            playing.length > 0 ? _('Other Rooms') : _('Rooms'),
            rooms,
            false);
    }

    _addGroupSection(title, groups, playing) {
        if (groups.length === 0)
            return;

        this._contentSection.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem(title));
        for (const group of groups)
            this._contentSection.addMenuItem(
                this._createGroupItem(group, playing));
    }

    _createGroupItem(group, playing) {
        let iconName = 'audio-speakers-symbolic';
        if (playing)
            iconName = 'media-playback-start-symbolic';
        else if (group.members.length > 1)
            iconName = 'emblem-shared-symbolic';

        const item = new PopupMenu.PopupImageMenuItem(
            groupLabel(group), iconName);
        item.label.x_expand = true;

        if (group.members.length > 1)
            this._addTrailingLabel(item, ngettext(
                '%d room',
                '%d rooms',
                group.members.length).replace('%d', group.members.length));

        item.add_child(PopupMenu.arrowIcon(St.Side.RIGHT));
        item.connect('activate', () => {
            if (this._operation)
                return;
            this._setView(ViewMode.MANUAL, coordinatorOf(group).id);
            this._queueViewTransition();
        });
        return this._trackMenuItem(item);
    }

    _renderRoomPicker() {
        const {speakers} = this._topology;
        const source = speakers.find(
            room => room.id === this._view.sourceRoomId);
        if (!source) {
            this._setView(ViewMode.AUTOMATIC);
            this._renderOverview();
            return;
        }

        const targetGroup = source.group;
        this.menu.setHeader(
            'audio-speakers-symbolic',
            source.name,
            this._isGroupPlaying(targetGroup)
                ? _('Playing in these rooms')
                : _('Choose rooms to play together'));
        this._resetMenuSections();

        const backItem = new PopupMenu.PopupImageMenuItem(
            _('Sonos'), 'go-previous-symbolic');
        backItem.connect('activate', () => {
            if (this._operation)
                return;
            this._setView(ViewMode.OVERVIEW);
            this._queueViewTransition();
        });
        this._trackMenuItem(backItem);
        this._contentSection.addMenuItem(backItem);
        this._contentSection.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem(_('Rooms')));

        for (const room of speakers) {
            const selected = room.group.id === targetGroup.id;
            const item = new PopupMenu.PopupMenuItem(room.name);
            item.accessible_role = Atk.Role.CHECK_MENU_ITEM;
            item.setOrnament(selected
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);

            // A listening group must retain at least one room.
            item.sensitive = !(selected && targetGroup.members.length === 1);
            item.connect('activate', () => {
                this._toggleRoom(room.id, !selected, item);
            });
            this._trackMenuItem(item);
            this._contentSection.addMenuItem(item);
        }

        const canPlayEverywhere = targetGroup.members.length < speakers.length;
        const canKeepOnlySource = targetGroup.members.length > 1;
        this._footerSeparator.visible = canPlayEverywhere || canKeepOnlySource;

        if (canPlayEverywhere) {
            const item = this._footerSection.addAction(
                _('Everywhere'),
                () => this._playEverywhere(item));
            this._trackMenuItem(item);
        }

        if (canKeepOnlySource) {
            const item = this._footerSection.addAction(
                _('Only %s').replace('%s', source.name),
                () => this._keepOnlySource(item));
            this._trackMenuItem(item);
        }
    }

    _trackMenuItem(item) {
        item.connect('notify::active', () => {
            if (item.active)
                this._activeMenuItem = item;
            else if (this._activeMenuItem === item)
                this._activeMenuItem = null;
        });
        item.connect('destroy', () => {
            if (this._activeMenuItem === item)
                this._activeMenuItem = null;
        });
        return item;
    }

    _deactivateMenuItem() {
        const item = this._activeMenuItem;
        this._activeMenuItem = null;
        if (item)
            item.active = false;
    }

    _addTrailingLabel(item, text) {
        const label = new St.Label({
            text,
            style_class: 'dim-label sonos-room-status',
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(label);
    }

    _setItemStatus(item, text) {
        item.label.x_expand = true;
        item.sensitive = false;
        this._addTrailingLabel(item, text);
    }

    _queueViewTransition() {
        if (this._viewTransitionId || this._destroyed)
            return;

        // PopupMenu runs its own activation bookkeeping after the item's
        // activate signal. Rebuilding here synchronously would destroy the
        // item while GNOME Shell is still using it.
        this._viewTransitionId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._viewTransitionId = 0;
                if (!this._destroyed && this._topology && this.menu.isOpen)
                    this._renderTopology();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelViewTransition() {
        if (!this._viewTransitionId)
            return;

        GLib.source_remove(this._viewTransitionId);
        this._viewTransitionId = 0;
    }

    _toggleRoom(roomId, selected, item) {
        if (this._operation)
            return;

        const source = this._topology.speakers.find(
            room => room.id === this._view.sourceRoomId);
        const room = this._topology.speakers.find(
            candidate => candidate.id === roomId);
        if (!source || !room)
            return;

        const targetGroup = source.group;
        this._setView(ViewMode.MANUAL, source.id);
        const alreadySelected = room.group.id === targetGroup.id;
        if (selected === alreadySelected)
            return;

        if (!selected && targetGroup.members.length === 1) {
            item.setOrnament(PopupMenu.Ornament.CHECK);
            return;
        }

        // Make the choice feel immediate. A topology refresh reconciles the
        // checkmark if Sonos rejects or changes the operation.
        item.setOrnament(selected
            ? PopupMenu.Ornament.CHECK
            : PopupMenu.Ornament.NONE);

        if (selected) {
            this._runAction(
                () => this._client.joinRoom(room, coordinatorOf(targetGroup)),
                {busyItem: item});
            return;
        }

        if (room.id === this._view.sourceRoomId) {
            const nextSource = targetGroup.members.find(
                member => member.id !== room.id);
            this._setView(ViewMode.MANUAL, nextSource.id);
        }

        this._runAction(
            () => this._client.leaveGroup(room),
            {busyItem: item});
    }

    _playEverywhere(item) {
        if (this._operation)
            return;

        const source = this._topology.speakers.find(
            room => room.id === this._view.sourceRoomId);
        if (!source)
            return;

        const topology = this._topology;
        this._setView(ViewMode.MANUAL, source.id);
        this._runAction(
            () => this._client.joinAll(topology, source.group),
            {busyItem: item, busyText: _('Grouping…')});
    }

    _keepOnlySource(item) {
        if (this._operation)
            return;

        const source = this._topology.speakers.find(
            room => room.id === this._view.sourceRoomId);
        if (!source)
            return;

        this._setView(ViewMode.MANUAL, source.id);
        this._runAction(
            () => this._client.keepOnly(source.group, source),
            {busyItem: item, busyText: _('Separating…')});
    }

    _runAction(action, {busyItem = null, busyText = null} = {}) {
        if (this._destroyed || this._operation)
            return;

        if (busyItem)
            busyItem.sensitive = false;

        if (busyText) {
            this._progressTimer = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                PROGRESS_DELAY_MS,
                () => {
                    this._progressTimer = 0;
                    this._showProgress(busyItem, busyText);
                    return GLib.SOURCE_REMOVE;
                });
        }

        // Any topology request started before this mutation may contain a
        // pre-action snapshot. The converged action result supersedes it.
        this._topologyGeneration++;
        const promise = this._performAction(action);
        this._operation = promise;
        promise.then(result => {
            if (this._operation !== promise)
                return;
            this._operation = null;
            this._finishAction(result);
        });
    }

    async _performAction(action) {
        let actionTopology = null;
        let actionError = null;
        try {
            const result = await action();
            if (result?.groups && result?.speakers)
                actionTopology = result;
        } catch (error) {
            actionError = error;
            if (!this._destroyed) {
                this._reportError(
                    error,
                    _('Sonos could not change the room group'));
            }
        }

        if (actionTopology)
            return {topology: actionTopology};

        try {
            return {topology: await this._client.getTopology()};
        } catch (error) {
            if (!this._destroyed) {
                if (actionError)
                    this._logger.error(error);
                else
                    this._reportError(error, _('Could not update Sonos rooms'));
            }
            return {topology: null};
        }
    }

    _showProgress(item, text) {
        if (this._destroyed || !this._operation)
            return;

        this.subtitle = text;
        this._contentSection.sensitive = false;
        this._footerSection.sensitive = false;
        if (item)
            this._setItemStatus(item, text);
    }

    _clearProgress() {
        if (this._progressTimer) {
            GLib.source_remove(this._progressTimer);
            this._progressTimer = 0;
        }
    }

    _finishAction({topology}) {
        this._clearProgress();
        if (this._destroyed)
            return;

        if (!topology) {
            this._topology = null;
            this._setView(ViewMode.AUTOMATIC);
            this._renderError();
            return;
        }

        this._topology = topology;
        if (this._view.sourceRoomId && !topology.speakers.some(
            room => room.id === this._view.sourceRoomId))
            this._setView(ViewMode.AUTOMATIC);

        if (!this.menu.isOpen)
            this._setView(ViewMode.AUTOMATIC);

        this._renderTopology(this.menu.isOpen);
        this._requestPlayback(topology);
    }

    _reportError(error, userMessage) {
        this._logger.error(error);
        Main.notifyError(_('Sonos'), userMessage);
    }
});

const SonosIndicator = GObject.registerClass(
class SonosIndicator extends QuickSettings.SystemIndicator {
    _init(client, logger) {
        super._init();

        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'emblem-shared-symbolic';
        this._indicator.visible = false;

        this._toggle = new SonosToggle(client, logger, grouped => {
            this._indicator.visible = grouped;
        });
        this.quickSettingsItems.push(this._toggle);
    }

    refresh(force = false) {
        return this._toggle.refresh(force);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class ChorusExtension extends Extension {
    enable() {
        const logger = this.getLogger();
        this._client = new SonosClient(logger);
        this._indicator = new SonosIndicator(this._client, logger);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._refreshTimer = setInterval(() => {
            this._indicator?.refresh().catch(error =>
                logger.debug(error.stack ?? error.message));
        }, BACKGROUND_REFRESH_INTERVAL_SECONDS * 1000);

        this._indicator.refresh().catch(error =>
            logger.debug(error.stack ?? error.message));
    }

    disable() {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }

        this._indicator?.destroy();
        this._indicator = null;

        this._client?.destroy();
        this._client = null;
    }
}
