import {
    parseTopologyResponse,
    parseTransportState,
} from '../sonos.js';
import {assert, assertEqual, assertThrows} from './assert.js';

function topologyResponse(state) {
    const escaped = state
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
    return `<s:Envelope><s:Body><u:GetZoneGroupStateResponse>` +
        `<u:ZoneGroupState>${escaped}</u:ZoneGroupState>` +
        `</u:GetZoneGroupStateResponse></s:Body></s:Envelope>`;
}

const inner = `<z:ZoneGroupState><z:ZoneGroups>` +
    `<z:ZoneGroup Coordinator='RINCON_KITCHEN' ID='group-kitchen'>` +
    `<z:ZoneGroupMember UUID='RINCON_KITCHEN' ` +
    `Location='http://192.0.2.10:1400/xml/device_description.xml' ` +
    `ZoneName='Kitchen &#38; Dining'/>` +
    `<z:ZoneGroupMember UUID='RINCON_OFFICE_RIGHT' Invisible='1' ` +
    `Location='http://192.0.2.11:1400/xml/device_description.xml' ` +
    `ZoneName='Office'/>` +
    `</z:ZoneGroup>` +
    `<z:ZoneGroup Coordinator="RINCON_LIBRARY" ID="group-library">` +
    `<z:ZoneGroupMember UUID="RINCON_LIBRARY" ` +
    `Location="http://192.0.2.12:1400/xml/device_description.xml" ` +
    `ZoneName="Library &amp; Study">` +
    `<z:Satellite UUID="RINCON_LIBRARY_SURROUND"/>` +
    `</z:ZoneGroupMember>` +
    `</z:ZoneGroup>` +
    `</z:ZoneGroups></z:ZoneGroupState>`;

const topology = parseTopologyResponse(topologyResponse(inner));

assertEqual(topology.groups.length, 2, 'expected two groups');
assertEqual(topology.speakers.length, 2,
    'invisible stereo member must be hidden');
assertEqual(topology.speakers[0].name, 'Kitchen & Dining',
    'numeric XML entities must be decoded');
assertEqual(topology.speakers[1].name, 'Library & Study',
    'named XML entities and nested members must be decoded');
assertEqual(topology.groups[0].coordinatorId, 'RINCON_KITCHEN',
    'coordinator must be retained');
assert(topology.groups[0].members[0].coordinator,
    'coordinator must sort before its peers');

const transportResponse = `<s:Envelope><s:Body>` +
    `<u:GetTransportInfoResponse>` +
    `<u:CurrentTransportState> playing </u:CurrentTransportState>` +
    `</u:GetTransportInfoResponse></s:Body></s:Envelope>`;
assertEqual(parseTransportState(transportResponse), 'PLAYING',
    'transport state must be normalized');

const missingRoomName = `<ZoneGroupState><ZoneGroups>` +
    `<ZoneGroup Coordinator="RINCON_KITCHEN">` +
    `<ZoneGroupMember UUID="RINCON_KITCHEN" ` +
    `Location="http://192.0.2.10:1400/device.xml"/>` +
    `</ZoneGroup></ZoneGroups></ZoneGroupState>`;
assertThrows(
    () => parseTopologyResponse(topologyResponse(missingRoomName)),
    'a malformed visible room must not look like an empty topology');

const missingGroups = `<ZoneGroupState><ZoneGroups/></ZoneGroupState>`;
assertThrows(
    () => parseTopologyResponse(topologyResponse(missingGroups)),
    'an unrecognized topology shape must fail at the protocol boundary');

print('parser tests passed');
