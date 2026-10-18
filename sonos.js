import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const AVAHI_NAME = 'org.freedesktop.Avahi';
const AVAHI_SERVER_PATH = '/';
const AVAHI_SERVER = 'org.freedesktop.Avahi.Server';
const AVAHI_SERVER2 = 'org.freedesktop.Avahi.Server2';
const AVAHI_BROWSER = 'org.freedesktop.Avahi.ServiceBrowser';

const TOPOLOGY_SERVICE =
    'urn:schemas-upnp-org:service:ZoneGroupTopology:1';
const AV_TRANSPORT_SERVICE =
    'urn:schemas-upnp-org:service:AVTransport:1';

const DISCOVERY_TIMEOUT_MS = 3000;
const HTTP_TIMEOUT_SECONDS = 5;
const TOPOLOGY_POLL_INITIAL_INTERVAL_MS = 100;
const TOPOLOGY_POLL_MAX_INTERVAL_MS = 500;
const TOPOLOGY_CONVERGENCE_TIMEOUT_MS = 4000;

function decodeXml(value) {
    const namedEntities = {
        quot: '"',
        apos: "'",
        gt: '>',
        lt: '<',
        amp: '&',
    };

    return value.replace(
        /&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(quot|apos|gt|lt|amp));/g,
        (reference, hexadecimal, decimal, named) => {
            if (named)
                return namedEntities[named];

            const codePoint = Number.parseInt(
                hexadecimal ?? decimal,
                hexadecimal ? 16 : 10);
            if (codePoint > 0x10FFFF ||
                (codePoint >= 0xD800 && codePoint <= 0xDFFF))
                return reference;

            return String.fromCodePoint(codePoint);
        });
}

function encodeXml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function parseAttributes(source) {
    const attributes = {};
    const expression =
        /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

    for (const match of source.matchAll(expression))
        attributes[match[1]] = decodeXml(match[2] ?? match[3]);

    return attributes;
}

function requiredAttribute(attributes, name, element) {
    const value = attributes[name];
    if (!value)
        throw new Error(`Sonos ${element} is missing ${name}`);
    return value;
}

function originFromLocation(location) {
    const match = location.match(/^https?:\/\/[^/]+/);
    if (!match)
        throw new Error(`Invalid Sonos device location: ${location}`);
    return match[0];
}

function topologyStateFromResponse(response) {
    const match = response.match(
        /<(?:[A-Za-z0-9_]+:)?ZoneGroupState>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?ZoneGroupState>/);
    if (!match)
        throw new Error('The Sonos response did not contain group topology');

    return decodeXml(match[1]);
}

export function parseTopologyResponse(response) {
    // ZoneGroupState is a second XML document escaped inside the SOAP reply.
    // This small reader targets that Sonos document shape and deliberately
    // accepts namespace prefixes, either attribute quote style, nested bonded
    // components, and named or numeric character references.
    const state = topologyStateFromResponse(response);
    const groups = [];
    const groupExpression =
        /<(?:[A-Za-z0-9_]+:)?ZoneGroup\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?ZoneGroup\s*>/g;
    const groupMatches = [...state.matchAll(groupExpression)];
    if (groupMatches.length === 0)
        throw new Error('The Sonos topology did not contain any groups');

    for (const groupMatch of groupMatches) {
        const groupAttributes = parseAttributes(groupMatch[1]);
        const advertisedCoordinator = requiredAttribute(
            groupAttributes, 'Coordinator', 'group');
        const members = [];
        const memberExpression =
            /<(?:[A-Za-z0-9_]+:)?ZoneGroupMember\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?ZoneGroupMember\s*>)/g;

        for (const memberMatch of groupMatch[2].matchAll(memberExpression)) {
            const attributes = parseAttributes(memberMatch[1]);

            // Bonded stereo/surround components appear as invisible players.
            // GNOME should expose the Sonos room, not its internal channels.
            if (attributes.Invisible === '1')
                continue;

            const id = requiredAttribute(attributes, 'UUID', 'room');
            const name = requiredAttribute(attributes, 'ZoneName', 'room');
            const location = requiredAttribute(attributes, 'Location', 'room');

            members.push({
                id,
                name,
                location,
                coordinator: id === advertisedCoordinator,
            });
        }

        if (members.length === 0)
            continue;

        // Some bonded configurations name an invisible component as the
        // coordinator. The first visible room is the usable group target.
        let coordinatorId = advertisedCoordinator;
        if (!members.some(member => member.id === coordinatorId))
            coordinatorId = members[0].id;

        for (const member of members)
            member.coordinator = member.id === coordinatorId;

        members.sort((left, right) => {
            if (left.coordinator !== right.coordinator)
                return left.coordinator ? -1 : 1;
            return left.name.localeCompare(right.name);
        });

        groups.push({
            id: groupAttributes.ID ?? coordinatorId,
            coordinatorId,
            members,
        });
    }

    if (groups.length === 0)
        throw new Error('The Sonos topology did not contain any visible rooms');

    groups.sort((left, right) =>
        left.members[0].name.localeCompare(right.members[0].name));

    const speakers = groups
        .flatMap(group => group.members.map(member => ({...member, group})))
        .sort((left, right) => left.name.localeCompare(right.name));

    return {groups, speakers};
}

export function parseTransportState(response) {
    const match = response.match(
        /<(?:[A-Za-z0-9_]+:)?CurrentTransportState>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?CurrentTransportState>/);
    if (!match)
        throw new Error('The Sonos response did not contain a transport state');

    return decodeXml(match[1].trim()).toUpperCase();
}

function soapEnvelope(service, action, parameters = {}) {
    const argumentsXml = Object.entries(parameters)
        .map(([name, value]) => `<${name}>${encodeXml(value)}</${name}>`)
        .join('');

    return `<?xml version="1.0" encoding="utf-8"?>` +
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
        `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
        `<s:Body><u:${action} xmlns:u="${service}">` +
        `${argumentsXml}</u:${action}></s:Body></s:Envelope>`;
}

function dbusCall(path, interfaceName, method, parameters, timeoutMs) {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(
            AVAHI_NAME,
            path,
            interfaceName,
            method,
            parameters,
            null,
            Gio.DBusCallFlags.NONE,
            timeoutMs,
            null,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

function delay(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function groupContaining(topology, roomId) {
    return topology.groups.find(group =>
        group.members.some(member => member.id === roomId));
}

export function coordinatorOf(group) {
    return group.members.find(member => member.coordinator) ?? group.members[0];
}

export class SonosClient {
    constructor(logger = console) {
        this._logger = logger;
        this._session = new Soup.Session({timeout: HTTP_TIMEOUT_SECONDS});
        this._seedOrigin = null;
        this._destroyed = false;
    }

    destroy() {
        this._destroyed = true;
        this._session.abort();
        this._seedOrigin = null;
    }

    async _discoverOrigin() {
        if (this._destroyed)
            throw new Error('Sonos client has been stopped');

        const result = await dbusCall(
            AVAHI_SERVER_PATH,
            AVAHI_SERVER2,
            'ServiceBrowserPrepare',
            new GLib.Variant('(iissu)', [-1, -1, '_sonos._tcp', 'local', 0]),
            DISCOVERY_TIMEOUT_MS);
        const [browserPath] = result.deepUnpack();

        let subscriptionId = 0;
        let timeoutId = 0;
        let lastResolveError = null;
        try {
            const origin = await new Promise((resolve, reject) => {
                const finish = (callback, value) => {
                    if (timeoutId) {
                        GLib.source_remove(timeoutId);
                        timeoutId = 0;
                    }
                    callback(value);
                };

                subscriptionId = Gio.DBus.system.signal_subscribe(
                    AVAHI_NAME,
                    AVAHI_BROWSER,
                    'ItemNew',
                    browserPath,
                    null,
                    Gio.DBusSignalFlags.NONE,
                    (_connection, _sender, _path, _interface, _signal, params) => {
                        const [networkInterface, protocol, name, type, domain] =
                            params.deepUnpack();

                        dbusCall(
                            AVAHI_SERVER_PATH,
                            AVAHI_SERVER,
                            'ResolveService',
                            new GLib.Variant('(iisssiu)', [
                                networkInterface,
                                protocol,
                                name,
                                type,
                                domain,
                                -1,
                                0,
                            ]),
                            DISCOVERY_TIMEOUT_MS)
                            .then(resolveResult => {
                                const values = resolveResult.deepUnpack();
                                const address = values[7];
                                const host = address.includes(':') &&
                                    !address.startsWith('[')
                                    ? `[${address}]`
                                    : address;
                                // Sonos advertises its secure control port in
                                // _sonos._tcp. The local UPnP/SOAP interfaces
                                // used here remain on the standard port 1400.
                                finish(resolve, `http://${host}:1400`);
                            })
                            .catch(error => {
                                lastResolveError = error;
                            });
                    });

                timeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    DISCOVERY_TIMEOUT_MS,
                    () => {
                        timeoutId = 0;
                        reject(lastResolveError ?? new Error(
                            'No Sonos rooms were found on this network'));
                        return GLib.SOURCE_REMOVE;
                    });

                dbusCall(
                    browserPath,
                    AVAHI_BROWSER,
                    'Start',
                    null,
                    DISCOVERY_TIMEOUT_MS)
                    .catch(error => finish(reject, error));
            });

            return origin;
        } finally {
            if (subscriptionId)
                Gio.DBus.system.signal_unsubscribe(subscriptionId);
            if (timeoutId)
                GLib.source_remove(timeoutId);

            dbusCall(
                browserPath,
                AVAHI_BROWSER,
                'Free',
                null,
                DISCOVERY_TIMEOUT_MS).catch(error =>
                this._logger.debug(error.stack ?? error.message));
        }
    }

    async _post(origin, path, service, action, parameters = {}) {
        if (this._destroyed)
            throw new Error('Sonos client has been stopped');

        const message = Soup.Message.new('POST', `${origin}${path}`);
        if (!message)
            throw new Error('Could not construct the Sonos request');

        const body = soapEnvelope(service, action, parameters);
        message.request_headers.append(
            'SOAPACTION', `"${service}#${action}"`);
        message.set_request_body_from_bytes(
            'text/xml; charset="utf-8"',
            new GLib.Bytes(new TextEncoder().encode(body)));

        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    try {
                        resolve(session.send_and_read_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
        });

        if (message.status_code < 200 || message.status_code >= 300) {
            throw new Error(
                `Sonos returned HTTP ${message.status_code} for ${action}`);
        }

        return new TextDecoder().decode(bytes.get_data());
    }

    async _fetchTopologyFrom(origin) {
        const response = await this._post(
            origin,
            '/ZoneGroupTopology/Control',
            TOPOLOGY_SERVICE,
            'GetZoneGroupState');
        return parseTopologyResponse(response);
    }

    async getTopology() {
        if (this._seedOrigin) {
            try {
                return await this._fetchTopologyFrom(this._seedOrigin);
            } catch (error) {
                this._logger.debug(error.stack ?? error.message);
                this._seedOrigin = null;
            }
        }

        this._seedOrigin = await this._discoverOrigin();
        return this._fetchTopologyFrom(this._seedOrigin);
    }

    async getPlaybackStates(topology) {
        const entries = await Promise.all(topology.groups.map(async group => {
            const coordinator = coordinatorOf(group);

            try {
                const response = await this._post(
                    originFromLocation(coordinator.location),
                    '/MediaRenderer/AVTransport/Control',
                    AV_TRANSPORT_SERVICE,
                    'GetTransportInfo',
                    {InstanceID: 0});
                return [coordinator.id, parseTransportState(response)];
            } catch (error) {
                // One sleeping or unavailable room should not make the entire
                // room picker unavailable.
                this._logger.debug(error.stack ?? error.message);
                return [coordinator.id, 'UNKNOWN'];
            }
        }));

        return new Map(entries);
    }

    async _waitForTopology(predicate, description) {
        const deadline = GLib.get_monotonic_time() +
            TOPOLOGY_CONVERGENCE_TIMEOUT_MS * 1000;
        let lastError = null;
        let observedTopology = false;
        let pollInterval = TOPOLOGY_POLL_INITIAL_INTERVAL_MS;

        do {
            if (this._destroyed)
                throw new Error('Sonos client has been stopped');

            try {
                const topology = await this.getTopology();
                observedTopology = true;
                lastError = null;
                if (predicate(topology))
                    return topology;
            } catch (error) {
                lastError = error;
            }

            await delay(pollInterval);
            pollInterval = Math.min(
                pollInterval * 2,
                TOPOLOGY_POLL_MAX_INTERVAL_MS);
        } while (GLib.get_monotonic_time() < deadline);

        if (!observedTopology && lastError)
            throw lastError;
        throw new Error(`Sonos did not finish ${description}`);
    }

    async _requestJoin(room, coordinator) {
        return this._post(
            originFromLocation(room.location),
            '/MediaRenderer/AVTransport/Control',
            AV_TRANSPORT_SERVICE,
            'SetAVTransportURI',
            {
                InstanceID: 0,
                CurrentURI: `x-rincon:${coordinator.id}`,
                CurrentURIMetaData: '',
            });
    }

    async joinRoom(room, coordinator) {
        if (room.id === coordinator.id)
            return this.getTopology();

        await this._requestJoin(room, coordinator);

        return this._waitForTopology(topology => {
            const roomGroup = groupContaining(topology, room.id);
            const coordinatorGroup = groupContaining(topology, coordinator.id);
            return roomGroup && roomGroup === coordinatorGroup;
        }, `grouping ${room.name}`);
    }

    async _requestLeave(room) {
        return this._post(
            originFromLocation(room.location),
            '/MediaRenderer/AVTransport/Control',
            AV_TRANSPORT_SERVICE,
            'BecomeCoordinatorOfStandaloneGroup',
            {InstanceID: 0});
    }

    async leaveGroup(room) {
        await this._requestLeave(room);

        return this._waitForTopology(topology => {
            const roomGroup = groupContaining(topology, room.id);
            return roomGroup?.members.length === 1;
        }, `separating ${room.name}`);
    }

    async joinAll(topology, targetGroup) {
        const coordinator = coordinatorOf(targetGroup);
        const targetRoomIds = new Set(
            targetGroup.members.map(member => member.id));
        const joiningRooms = topology.speakers.filter(
            room => !targetRoomIds.has(room.id));
        if (joiningRooms.length === 0)
            return topology;

        await Promise.all(joiningRooms.map(room =>
            this._requestJoin(room, coordinator)));
        const roomIds = topology.speakers.map(room => room.id);
        return this._waitForTopology(candidate => {
            const coordinatorGroup = groupContaining(candidate, coordinator.id);
            return coordinatorGroup && roomIds.every(roomId =>
                groupContaining(candidate, roomId) === coordinatorGroup);
        }, 'grouping every room');
    }

    async keepOnly(group, sourceRoom) {
        const otherRooms = group.members.filter(room => room.id !== sourceRoom.id);
        if (otherRooms.length === 0)
            return this.getTopology();

        const peers = otherRooms.filter(room => !room.coordinator);
        const coordinator = otherRooms.find(room => room.coordinator);
        let convergedTopology = null;
        if (peers.length > 0) {
            await Promise.all(peers.map(room => this._requestLeave(room)));
            convergedTopology = await this._waitForTopology(topology => {
                if (!peers.every(room =>
                    groupContaining(topology, room.id)?.members.length === 1))
                    return false;
                if (coordinator)
                    return true;
                return groupContaining(topology, sourceRoom.id)?.members.length === 1;
            }, 'separating rooms');
        }

        // A non-coordinator source depends on its coordinator until all peers
        // have left. Detach that coordinator as a final phase.
        if (!coordinator)
            return convergedTopology;

        await this._requestLeave(coordinator);
        return this._waitForTopology(topology =>
            groupContaining(topology, sourceRoom.id)?.members.length === 1,
        `keeping only ${sourceRoom.name}`);
    }

}
