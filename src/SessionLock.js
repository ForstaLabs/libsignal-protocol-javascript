 /*
  * jobQueue manages multiple queues indexed by device to serialize
  * session io ops on the database.
  */
;(function() {
    'use strict';

    Internal.SessionLock = {};
    const jobQueue = {};

    Internal.SessionLock.queueJobForNumber = async function queueJobForNumber(number, job) {
        const running = jobQueue[number];
        jobQueue[number] = job;
        try {
            // Wait for current job to finish first...
            if (running) {
                await running;
            }
        } finally {
            try {
                return await job();
            } finally {
                if (jobQueue[number] === job) {
                    delete jobQueue[number];  // We're the last one, do cleanup.
                }
            }
        }
    };
})();
