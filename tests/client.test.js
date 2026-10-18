import {SonosClient} from '../sonos.js';
import {assert, assertEqual} from './assert.js';

const topology = {
    groups: [
        {
            id: 'group-kitchen',
            coordinatorId: 'kitchen',
            members: [{
                id: 'kitchen',
                name: 'Kitchen',
                location: 'http://192.0.2.10:1400/device.xml',
                coordinator: true,
            }],
        },
        {
            id: 'group-library',
            coordinatorId: 'library',
            members: [{
                id: 'library',
                name: 'Library',
                location: 'http://192.0.2.11:1400/device.xml',
                coordinator: true,
            }],
        },
    ],
};
topology.speakers = topology.groups.flatMap(group =>
    group.members.map(room => ({...room, group})));

const transportResponse = `<s:Envelope><s:Body>` +
    `<u:GetTransportInfoResponse>` +
    `<CurrentTransportState>PLAYING</CurrentTransportState>` +
    `</u:GetTransportInfoResponse></s:Body></s:Envelope>`;

const playbackClient = new SonosClient();
try {
    playbackClient._post = async (_origin, _path, _service, action) => {
        assertEqual(action, 'GetTransportInfo',
            'playback detection must only read transport information');
        return transportResponse;
    };
    const states = await playbackClient.getPlaybackStates(topology);
    assertEqual(states.get('kitchen'), 'PLAYING',
        'playback must be keyed by coordinator');
    assertEqual(states.get('library'), 'PLAYING',
        'every coordinator must be queried');
} finally {
    playbackClient.destroy();
}

const sourceGroup = topology.groups[0];
const coordinator = sourceGroup.members[0];
assert(coordinator.group === undefined,
    'group members must not require a synthetic backlink');

const joinAllClient = new SonosClient();
try {
    const joined = [];
    joinAllClient.joinRoom = async (room, target) => {
        joined.push([room.id, target.id]);
        return topology;
    };
    await joinAllClient.joinAll(topology, sourceGroup);
    assertEqual(joined.length, 1,
        'play everywhere must skip the target group');
    assertEqual(joined[0][0], 'library',
        'play everywhere must join rooms outside the target group');
    assertEqual(joined[0][1], coordinator.id,
        'rooms must join the selected coordinator');
} finally {
    joinAllClient.destroy();
}

const groupedTopology = {
    groups: [{
        id: 'joined',
        members: [{id: 'coordinator'}, {id: 'new-room'}],
    }],
    speakers: [],
};

const convergenceClient = new SonosClient();
try {
    convergenceClient.getTopology = async () => groupedTopology;
    const result = await convergenceClient._waitForTopology(
        candidate => candidate === groupedTopology,
        'test convergence');
    assert(result === groupedTopology,
        'convergence must return the matching topology');
} finally {
    convergenceClient.destroy();
}

const joinClient = new SonosClient();
try {
    let joinAction = null;
    joinClient._post = async (_origin, _path, _service, action, parameters) => {
        joinAction = [action, parameters.CurrentURI];
    };
    joinClient._waitForTopology = async predicate => {
        assert(predicate(groupedTopology),
            'join convergence must require both rooms in one group');
        return groupedTopology;
    };
    const result = await joinClient.joinRoom({
        id: 'new-room',
        name: 'New Room',
        location: 'http://192.0.2.20:1400/device.xml',
    }, {id: 'coordinator'});
    assertEqual(joinAction.join(','),
        'SetAVTransportURI,x-rincon:coordinator',
        'joining must target the selected coordinator');
    assert(result === groupedTopology,
        'joining must return the converged topology');
} finally {
    joinClient.destroy();
}

const standaloneTopology = {
    groups: [{id: 'standalone', members: [{id: 'new-room'}]}],
    speakers: [],
};

const leaveClient = new SonosClient();
try {
    leaveClient._post = async (_origin, _path, _service, action) => {
        assertEqual(action, 'BecomeCoordinatorOfStandaloneGroup',
            'leaving must request a standalone group');
    };
    leaveClient._waitForTopology = async predicate => {
        assert(predicate(standaloneTopology),
            'leave convergence must require a singleton group');
        return standaloneTopology;
    };
    const result = await leaveClient.leaveGroup({
        id: 'new-room',
        name: 'New Room',
        location: 'http://192.0.2.20:1400/device.xml',
    });
    assert(result === standaloneTopology,
        'leaving must return the converged topology');
} finally {
    leaveClient.destroy();
}

const keepOnlyClient = new SonosClient();
try {
    const left = [];
    keepOnlyClient.leaveGroup = async room => {
        left.push(room.id);
        return standaloneTopology;
    };
    await keepOnlyClient.keepOnly({
        members: [
            {id: 'coordinator', coordinator: true},
            {id: 'source', coordinator: false},
            {id: 'peer', coordinator: false},
        ],
    }, {id: 'source'});
    assertEqual(left.join(','), 'peer,coordinator',
        'a non-coordinator source must detach its coordinator last');
} finally {
    keepOnlyClient.destroy();
}

print('client tests passed');
