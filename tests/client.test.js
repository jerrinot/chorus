import {SonosClient} from '../sonos.js';
import {assert, assertEqual} from './assert.js';

function group(id, ...members) {
    return {
        id,
        coordinatorId: members[0].id,
        members: members.map((member, index) => ({
            ...member,
            coordinator: index === 0,
        })),
    };
}

function topology(...groups) {
    const result = {groups};
    result.speakers = groups.flatMap(currentGroup =>
        currentGroup.members.map(room => ({...room, group: currentGroup})));
    return result;
}

function room(id, address) {
    return {
        id,
        name: id[0].toUpperCase() + id.slice(1),
        location: `http://${address}:1400/device.xml`,
    };
}

class RecordingClient extends SonosClient {
    constructor({response = '', convergedTopologies = []} = {}) {
        super();
        this.posts = [];
        this.waits = [];
        this._response = response;
        this._convergedTopologies = [...convergedTopologies];
    }

    async _post(origin, path, service, action, parameters) {
        this.posts.push({origin, path, service, action, parameters});
        return this._response;
    }

    async _waitForTopology(predicate, description) {
        const candidate = this._convergedTopologies.shift();
        assert(candidate, `missing converged topology for ${description}`);
        assert(predicate(candidate), `topology must prove ${description}`);
        this.waits.push(description);
        return candidate;
    }
}

const kitchen = room('kitchen', '192.0.2.10');
const library = room('library', '192.0.2.11');
const office = room('office', '192.0.2.12');
const separateTopology = topology(
    group('group-kitchen', kitchen),
    group('group-library', library),
    group('group-office', office));

async function testPlaybackStates() {
    const response = `<s:Envelope><s:Body>` +
        `<u:GetTransportInfoResponse>` +
        `<CurrentTransportState>PLAYING</CurrentTransportState>` +
        `</u:GetTransportInfoResponse></s:Body></s:Envelope>`;
    const client = new RecordingClient({response});
    try {
        const states = await client.getPlaybackStates(separateTopology);
        assertEqual(states.size, 3, 'every coordinator must be queried');
        assertEqual(states.get('kitchen'), 'PLAYING',
            'playback must be keyed by coordinator');
        assert(client.posts.every(post => post.action === 'GetTransportInfo'),
            'playback detection must only read transport information');
    } finally {
        client.destroy();
    }
}

async function testJoinRoom() {
    const joinedTopology = topology(group('joined', kitchen, library));
    const client = new RecordingClient({convergedTopologies: [joinedTopology]});
    try {
        const result = await client.joinRoom(library, kitchen);
        assert(result === joinedTopology,
            'joining must return the converged topology');
        assertEqual(client.posts[0].action, 'SetAVTransportURI',
            'joining must use the Sonos grouping action');
        assertEqual(client.posts[0].parameters.CurrentURI, 'x-rincon:kitchen',
            'joining must target the selected coordinator');
        assertEqual(client.waits.length, 1,
            'a single join needs one convergence wait');
    } finally {
        client.destroy();
    }
}

async function testLeaveRoom() {
    const standaloneTopology = topology(group('standalone', library));
    const client = new RecordingClient({convergedTopologies: [standaloneTopology]});
    try {
        const result = await client.leaveGroup(library);
        assert(result === standaloneTopology,
            'leaving must return the converged topology');
        assertEqual(client.posts[0].action, 'BecomeCoordinatorOfStandaloneGroup',
            'leaving must request a standalone group');
        assertEqual(client.waits.length, 1,
            'a single leave needs one convergence wait');
    } finally {
        client.destroy();
    }
}

async function testJoinAllAsOneBatch() {
    const joinedTopology = topology(group('joined', kitchen, library, office));
    const client = new RecordingClient({convergedTopologies: [joinedTopology]});
    try {
        const result = await client.joinAll(
            separateTopology, separateTopology.groups[0]);
        assert(result === joinedTopology,
            'play everywhere must return the final topology');
        assertEqual(client.posts.length, 2,
            'play everywhere must request every room outside the target group');
        assert(client.posts.every(post =>
            post.parameters.CurrentURI === 'x-rincon:kitchen'),
            'every room must join the selected coordinator');
        assertEqual(client.waits.length, 1,
            'play everywhere must converge once after the mutation batch');
    } finally {
        client.destroy();
    }
}

async function testKeepOnlyInTwoPhases() {
    const grouped = group('all', kitchen, library, office);
    const peerSeparated = topology(
        group('kitchen-and-library', kitchen, library),
        group('office-only', office));
    const allSeparated = topology(
        group('kitchen-only', kitchen),
        group('library-only', library),
        group('office-only', office));
    const client = new RecordingClient({
        convergedTopologies: [peerSeparated, allSeparated],
    });
    try {
        const result = await client.keepOnly(grouped, library);
        assert(result === allSeparated,
            'keep only must return the final topology');
        assertEqual(client.posts.length, 2,
            'keep only must detach every other room');
        assertEqual(client.posts[0].origin, 'http://192.0.2.12:1400',
            'peers must leave before the coordinator');
        assertEqual(client.posts[1].origin, 'http://192.0.2.10:1400',
            'the coordinator must leave in the final phase');
        assertEqual(client.waits.length, 2,
            'coordinator-last grouping requires exactly two convergence phases');
    } finally {
        client.destroy();
    }
}

async function testKeepCoordinatorOnlyAsOneBatch() {
    const grouped = group('all', kitchen, library, office);
    const allSeparated = topology(
        group('kitchen-only', kitchen),
        group('library-only', library),
        group('office-only', office));
    const client = new RecordingClient({convergedTopologies: [allSeparated]});
    try {
        const result = await client.keepOnly(grouped, kitchen);
        assert(result === allSeparated,
            'keeping the coordinator must return the final topology');
        assertEqual(client.posts.length, 2,
            'all peers must receive a leave request');
        assertEqual(client.waits.length, 1,
            'independent peers must converge as one batch');
    } finally {
        client.destroy();
    }
}

await testPlaybackStates();
await testJoinRoom();
await testLeaveRoom();
await testJoinAllAsOneBatch();
await testKeepOnlyInTwoPhases();
await testKeepCoordinatorOnlyAsOneBatch();

print('client tests passed');
