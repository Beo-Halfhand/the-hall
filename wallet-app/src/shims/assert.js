// The address decoder's codec calls Node's assert. This is all of it that runs in a browser.
export default function assert(value, message) {
  if (!value) throw new Error(message ?? 'Assertion failed');
}
assert.ok = assert;
