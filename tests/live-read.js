import {SonosClient} from '../sonos.js';

const client = new SonosClient();

try {
    const topology = await client.getTopology();
    const playbackStates = await client.getPlaybackStates(topology);
    for (const group of topology.groups) {
        const rooms = group.members.map(member => member.name).join(' + ');
        print(`${rooms} [${playbackStates.get(group.coordinatorId)}]`);
    }
} finally {
    client.destroy();
}
