import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, cleanSay, isProfane } from '../src/platform/filter.js';

test('say: length limit is 120 characters', () => {
  assert.equal(cleanSay('x'.repeat(120)).text.length, 120);
  assert.match(cleanSay('x'.repeat(121)).error, /limit is 120/);
  assert.ok(cleanSay('   ').error);
  assert.ok(cleanSay(5).error);
  assert.ok(cleanSay(undefined).error);
});

test('say: masks bad words, including simple disguises', () => {
  assert.equal(cleanSay('well fuck that').text, 'well **** that');
  assert.equal(cleanSay('FUCKING hell').text, '******* hell');
  assert.equal(cleanSay('sh1t happens').text, '**** happens');
  assert.equal(cleanSay('fuuuuck').text, '*******');
  assert.equal(cleanSay('you b!tch').text, 'you *****');
});

test('say: leaves innocent words alone', () => {
  for (const text of ['Scunthorpe is lovely', 'feeling cocky today', 'spicy bass class assess', 'as I said, pass it', 'dicey hand, Dickens', 'that was a shift', 'well done, $5 well spent!']) {
    assert.equal(cleanSay(text).text, text);
  }
  assert.equal(isProfane('pass'), false);
});

test('say: strips control and invisible characters', () => {
  assert.equal(cleanSay('hi\nthere​\u0007  friend').text, 'hi there friend');
});

test('name: 1 to 24 plain characters, no bad words', () => {
  assert.equal(cleanName(" Beo's Porter ").name, "Beo's Porter");
  assert.ok(cleanName('').error);
  assert.ok(cleanName('x'.repeat(25)).error);
  assert.ok(cleanName('<script>').error);
  assert.ok(cleanName(7).error);
  assert.ok(cleanName('big shit').error);
});
