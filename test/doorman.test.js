// Tally keeps the door (The owner, 11-06): one doorman, no setting and no ?doorman= switch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DOORMAN_ID, doormanFor, isDoormanName } from '../src/platform/doorman.js';

test('doorman: Tally, whatever the settings or the address say; no mock-up list', () => {
  assert.equal(DOORMAN_ID, 'tally');
  for (const [env, url] of [[{}, null], [{ DOORMAN: 'clockwork' }, null], [{ DOORMAN: 'mott', DOORMAN_PICKER: 'on' }, 'https://x.workers.dev/hall?doorman=mott']]) {
    const d = doormanFor(env, url);
    assert.equal(d.name, 'Tally');
    assert.equal(d.look, 'tally');
    assert.equal(d.doorman, 'tally');
    assert.equal(d.doormen, undefined, 'no picker');
    assert.ok(d.greeting.some((line) => line.includes("I'm Tally")));
  }
});

test('doorman: the lines a visitor and an agent hear are all there', () => {
  const d = doormanFor();
  assert.equal(d.greeting.length, 2);
  for (const key of ['askName', 'doorAsk', 'welcomeIn', 'whichGame', 'whichWatch', 'askBuyIn', 'emptyPurse', 'upstairs', 'agents']) assert.ok(d[key], key);
  assert.equal(d.menu.length, 4);
  assert.ok(d.rules.length >= 6);
});

test('doorman: nobody new takes Tally\'s name or the retired Clockwork\'s, however it is spaced', () => {
  for (const name of ['Tally', 'tally', 'T a l l y', 'Clockwork', 'clock-work.']) assert.equal(isDoormanName(name), true, name);
  for (const name of ['The owner', 'Tallyho', 'Hollis', 'Mott', 'Tally · house']) assert.equal(isDoormanName(name), false, name);
});
