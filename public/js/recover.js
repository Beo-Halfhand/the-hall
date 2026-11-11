// The old address. A browser keeps its player key per address, so one that first played here can only get at it here.
// The key goes to the clipboard and nowhere else: never into an address, never onto the page.

(function setUp() {
  const $ = (id) => document.getElementById(id);
  let key = null;
  try {
    key = localStorage.getItem('hall.player');
  } catch { /* storage is blocked, so there's nothing here */ }
  $('none').hidden = !!key;
  $('found').hidden = !key;
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(key);
      $('status').textContent = 'Copied. Now open halfhand.app, choose Settings, and paste it under Restore.';
    } catch {
      $('status').textContent = 'Your browser wouldn’t let me copy it. Try another browser window at this address.';
    }
  });
}());
