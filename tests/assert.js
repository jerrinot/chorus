export function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

export function assertEqual(actual, expected, message) {
    if (!Object.is(actual, expected)) {
        throw new Error(
            `${message}: expected ${String(expected)}, got ${String(actual)}`);
    }
}

export async function assertRejects(promise, message) {
    try {
        await promise;
    } catch (_error) {
        return;
    }

    throw new Error(`${message}: expected rejection`);
}

export function assertThrows(callback, message) {
    try {
        callback();
    } catch (_error) {
        return;
    }

    throw new Error(`${message}: expected exception`);
}
