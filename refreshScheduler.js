export class RefreshScheduler {
    constructor(run, waitUntilIdle = async () => {}) {
        this._run = run;
        this._waitUntilIdle = waitUntilIdle;
        this._pending = null;
    }

    async request(force = false) {
        await this._waitUntilIdle();

        if (this._pending) {
            const pending = this._pending;
            if (!force)
                return pending;

            await pending;

            await this._waitUntilIdle();

            // Another forced waiter may already have started the one queued
            // refresh. Share it instead of creating parallel requests.
            if (this._pending)
                return this._pending;
        }

        const pending = Promise.resolve().then(() => this._run());
        this._pending = pending;
        try {
            return await pending;
        } finally {
            if (this._pending === pending)
                this._pending = null;
        }
    }
}
