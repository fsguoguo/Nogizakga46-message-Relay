import assert from 'node:assert/strict';
import test from 'node:test';

const { NogiWebMonitor } = await import('../src/monitor/nogi-web.js');
const { setErrorLogDbWriter } = await import('../src/services/error-log.js');
const { isTransientDatabaseError } = await import('../src/db/index.js');

setErrorLogDbWriter(null);

test('classifies database startup and connection timeout errors as transient', () => {
  assert.equal(isTransientDatabaseError(Object.assign(
    new Error('the database system is starting up'),
    { code: '57P03' },
  )), true);
  assert.equal(isTransientDatabaseError(new Error('Connection terminated due to connection timeout')), true);
  assert.equal(isTransientDatabaseError(Object.assign(new Error('syntax error'), { code: '42601' })), false);
});

test('keeps a message eligible when persistence fails', async () => {
  let saveAttempts = 0;
  let pushAttempts = 0;
  const monitor = new NogiWebMonitor({
    messageStore: {
      async saveMessage() {
        saveAttempts += 1;
        if (saveAttempts === 1) throw new Error('temporary database outage');
        return { isNew: true, message: { id: 'retry-1', type: 'text' } };
      },
      async getMessage() { return null; },
    },
    pusher: {
      async smartPush() {
        pushAttempts += 1;
        return { success: true };
      },
    },
  });
  monitor.resolveGroups = async () => [{ id: 48, name: '一ノ瀬 美空', phone_image: null, thumbnail: null }];
  monitor.fetchTimeline = async () => [{
    id: 'retry-1',
    type: 'text',
    text: 'retry me',
    published_at: '2026-09-04T11:10:51Z',
  }];

  await monitor.poll();
  assert.equal(saveAttempts, 1);
  assert.equal(pushAttempts, 0);

  await monitor.poll();
  assert.equal(saveAttempts, 2);
  assert.equal(pushAttempts, 1);
});
