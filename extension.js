import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {
    Extension,
    gettext as _,
    ngettext,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ChorusMenuView, groupLabel} from './menuView.js';
import {coordinatorOf, SonosClient} from './sonos.js';
import {RefreshScheduler} from './state.js';

const BACKGROUND_REFRESH_INTERVAL_SECONDS = 60;
const VISIBLE_REFRESH_INTERVAL_SECONDS = 5;
const PROGRESS_DELAY_MS = 300;
const ACTIVE_TRANSPORT_STATES = new Set(['PLAYING', 'TRANSITIONING']);

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
            automatic: true,
            sourceRoomId: null,
        };
        this._topologyGeneration = 0;
        this._operation = null;
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

        this._menuView = new ChorusMenuView(this.menu, {
            showRoomPicker: roomId => this._showRoomPicker(roomId),
            showOverview: () => this._showOverview(),
            toggleRoom: (roomId, selected, item) =>
                this._toggleRoom(roomId, selected, item),
            playEverywhere: item => this._playEverywhere(item),
            keepOnly: item => this._keepOnlySource(item),
            retry: () => this.refresh(true).catch(error =>
                this._reportError(error, _('Could not update Sonos rooms'))),
        });

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._startVisibleRefresh();
                if (!this._operation) {
                    this._resetView();
                    this._selectOnlyPlayingGroup();
                    if (this._topology)
                        this._renderTopology();
                }
                this.refresh(true).catch(error =>
                    this._reportError(error, _('Could not update Sonos rooms')));
            } else {
                this._stopVisibleRefresh();
                if (!this._operation)
                    this._resetView();
            }
        });
        this.connect('clicked', () => this.menu.open());
        this.connect('destroy', () => this._stop());

        this._renderLoading();
    }

    destroy() {
        this._stop();
        super.destroy();
    }

    _stop() {
        if (this._destroyed)
            return;

        this._destroyed = true;
        this._stopVisibleRefresh();
        if (this._progressTimer) {
            GLib.source_remove(this._progressTimer);
            this._progressTimer = 0;
        }
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

            this._applyTopology(topology);
        } catch (error) {
            if (this._destroyed || generation !== this._topologyGeneration)
                return;
            this._showUnavailable();
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
        if (!this._topology || !this._view.automatic)
            return;

        const playingGroups = this._playingGroups();
        this._view.sourceRoomId = playingGroups.length === 1
            ? coordinatorOf(playingGroups[0]).id
            : null;
    }

    _resetView() {
        this._view = {automatic: true, sourceRoomId: null};
    }

    _setManualView(sourceRoomId = null) {
        this._view = {automatic: false, sourceRoomId};
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
        this.subtitle = _('Finding rooms…');
        this.reactive = false;
        this._menuView.showLoading();
        this._stateChanged(false);
    }

    _renderError() {
        this.subtitle = _('Unavailable');
        this.reactive = true;
        this._menuView.showError();
        this._stateChanged(false);
    }

    _showUnavailable() {
        this._topology = null;
        this._playback.states.clear();
        this._resetView();
        this._renderError();
    }

    _applyTopology(topology) {
        this._topology = topology;
        if (this._view.sourceRoomId && !topology.speakers.some(
            room => room.id === this._view.sourceRoomId))
            this._resetView();

        if (this.menu.isOpen)
            this._selectOnlyPlayingGroup();
        this._renderTopology();
        this._requestPlayback(topology);
    }

    _renderTopology() {
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

        if (this.menu.isOpen) {
            this._menuView.render(
                this._topology,
                this._view.sourceRoomId,
                group => this._isGroupPlaying(group));
        }

        this._stateChanged(grouped.length > 0);
    }

    _showRoomPicker(roomId) {
        if (this._operation)
            return;
        this._setManualView(roomId);
        this._renderTopology();
    }

    _showOverview() {
        if (this._operation)
            return;
        this._setManualView();
        this._renderTopology();
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
        this._setManualView(source.id);
        const alreadySelected = room.group.id === targetGroup.id;
        if (selected === alreadySelected)
            return;

        if (!selected && targetGroup.members.length === 1) {
            this._menuView.setRoomSelected(item, true);
            return;
        }

        // Make the choice feel immediate. A topology refresh reconciles the
        // checkmark if Sonos rejects or changes the operation.
        this._menuView.setRoomSelected(item, selected);

        if (selected) {
            this._runAction(
                () => this._client.joinRoom(room, coordinatorOf(targetGroup)),
                {busyItem: item});
            return;
        }

        if (room.id === this._view.sourceRoomId) {
            const nextSource = targetGroup.members.find(
                member => member.id !== room.id);
            this._setManualView(nextSource.id);
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
        this._setManualView(source.id);
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

        this._setManualView(source.id);
        this._runAction(
            () => this._client.keepOnly(source.group, source),
            {busyItem: item, busyText: _('Separating…')});
    }

    _runAction(action, {busyItem = null, busyText = null} = {}) {
        if (this._destroyed || this._operation)
            return;

        this._menuView.startBusy(busyItem);

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
        promise.then(topology => {
            if (this._operation !== promise)
                return;
            this._operation = null;
            this._finishAction(topology);
        });
    }

    async _performAction(action) {
        let actionError = null;
        try {
            return await action();
        } catch (error) {
            actionError = error;
            if (!this._destroyed) {
                this._reportError(
                    error,
                    _('Sonos could not change the room group'));
            }
        }

        try {
            return await this._client.getTopology();
        } catch (error) {
            if (!this._destroyed) {
                if (actionError)
                    this._logger.error(error);
                else
                    this._reportError(error, _('Could not update Sonos rooms'));
            }
            return null;
        }
    }

    _showProgress(item, text) {
        if (this._destroyed || !this._operation)
            return;

        this.subtitle = text;
        this._menuView.showBusy(item, text);
    }

    _clearProgress() {
        if (this._progressTimer) {
            GLib.source_remove(this._progressTimer);
            this._progressTimer = 0;
        }
        this._menuView.clearBusy();
    }

    _finishAction(topology) {
        this._clearProgress();
        if (this._destroyed)
            return;

        if (!topology) {
            this._showUnavailable();
            return;
        }

        if (!this.menu.isOpen)
            this._resetView();

        this._applyTopology(topology);
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
        this._indicator.connect('destroy', () => {
            this._indicator = null;
        });

        this._toggle = new SonosToggle(client, logger, grouped => {
            if (this._indicator)
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
