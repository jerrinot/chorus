import {RefreshScheduler, ViewMode} from '../state.js';
import {assertEqual, assertRejects} from './assert.js';

async function flushMicrotasks() {
    for (let iteration = 0; iteration < 8; iteration++)
        await Promise.resolve();
}

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => {
        resolve = resolvePromise;
    });
    return {promise, resolve};
}

assertEqual(ViewMode.AUTOMATIC, 'automatic',
    'automatic view mode must remain explicit');

let runs = 0;
const requests = [];
const scheduler = new RefreshScheduler(() => {
    runs++;
    const request = deferred();
    requests.push(request);
    return request.promise;
});

const first = scheduler.request();
const second = scheduler.request(true);
const third = scheduler.request(true);
await flushMicrotasks();
assertEqual(runs, 1, 'concurrent requests must share the active refresh');

requests.shift().resolve('first');
await flushMicrotasks();
assertEqual(runs, 2, 'forced waiters must queue exactly one refresh');

requests.shift().resolve('second');
const results = await Promise.all([first, second, third]);
assertEqual(results[0], 'first', 'the initial caller receives its result');
assertEqual(results[1], 'second', 'the forced caller receives the queued result');
assertEqual(results[2], 'second', 'forced callers share the queued result');

let attempt = 0;
const recovering = new RefreshScheduler(async () => {
    attempt++;
    if (attempt === 1)
        throw new Error('expected failure');
    return 'recovered';
});
await assertRejects(recovering.request(),
    'a failed refresh must reject its caller');
assertEqual(await recovering.request(), 'recovered',
    'a failed refresh must not leave the scheduler locked');

print('state tests passed');
