// The table page's link to the Hall, said plainly (11-10: "card state needs to survive a dropped connection"). Shared by both games.
//
// The table lives on the server: seat, hand or cup, stack and whose turn are all there, so a page that drops and comes back reads them
// again and is where it was. What a person needs is to be told so. This banner says:
//   lost   "Connection lost. Your seat and cards are safe. Reconnecting…", with their turn's clock if it is their turn
//   back   "Back in. Your turn." (or whose turn it is), for a few seconds
//   moved  "This seat is open in another tab or on another device now…" (the newest page wins; the older one only watches)
// and asks the page to look again the moment the browser is back online or the tab is shown again.
//
//   const conn = mountConnection({ noun: 'cards', situation: () => ({ myTurn, turnName, deadlineIn, away, solo }), wake: () => pollNow() });
//   conn.ok() after a poll that worked · conn.failed(err) after one that didn't · conn.moved() / conn.clearMoved()

const LOST_AFTER = 2; // one failed poll can be a blip; two in a row, or the browser saying it is offline, is a lost connection
const BACK_MS = 6000;

/** The lines for a state, pure (tested). sit: { seated, myTurn, turnName, deadlineIn (ms, server clock) | null, away }. */
export function connectionText(state, sit = {}, noun = 'cards') {
  if (state === 'lost') {
    if (sit.seated === false) return { head: 'Connection lost. Reconnecting…', more: '' }; // just watching: there is no seat to keep
    const head = `Connection lost. Your seat and ${noun} are safe. Reconnecting…`;
    if (!sit.myTurn) return { head, more: '' };
    if (sit.deadlineIn === null || sit.deadlineIn === undefined) return { head, more: 'It’s your turn, and the table waits for you.' };
    const secs = Math.max(0, Math.ceil(sit.deadlineIn / 1000));
    return { head, more: secs > 0 ? `It’s your turn: ${secs} s left on its clock, then the table moves for you until you’re back.` : 'Your turn’s clock ran out: the table is moving for you until you’re back.' };
  }
  if (state === 'back') {
    const head = sit.myTurn ? 'Back in. Your turn.' : sit.turnName ? `Back in. ${sit.turnName}’s turn.` : 'Back in.';
    return { head, more: sit.away ? 'You were marked away while you were gone, so the table moved for you. Press I’m back to play again yourself.' : '' };
  }
  if (state === 'moved') return { head: 'This seat is open in another tab or on another device now.', more: `This page only watches. Your seat, stack and ${noun} are with the newer page; take it back below if you want it here.` };
  return { head: '', more: '' };
}

export function mountConnection({ noun = 'cards', situation = () => ({}), wake = () => {} } = {}) {
  let failures = 0;
  let state = 'ok'; // ok | lost | back | moved
  let lostAt = 0; // a poll that set out before this can't say the connection is back (11-10: one in flight as the browser went offline did)
  let backTimer = null;
  let tickTimer = null;
  let el = null;

  const banner = () => {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'conn-banner';
    el.className = 'conn-banner';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    el.innerHTML = '<span class="conn-dot" aria-hidden="true"></span><span class="conn-text"><b class="conn-head"></b> <span class="conn-more"></span></span>';
    // Under the page's header, full width, like the in-flight banner.
    const anchor = document.getElementById('inflight') ?? document.querySelector('header.hud') ?? document.querySelector('.topbar');
    if (anchor) anchor.after(el); else document.body.prepend(el);
    return el;
  };
  const paint = () => {
    const b = banner();
    if (state === 'ok') { b.hidden = true; return; }
    const { head, more } = connectionText(state, safeSit(), noun);
    b.dataset.state = state;
    b.querySelector('.conn-head').textContent = head;
    b.querySelector('.conn-more').textContent = more;
    b.hidden = false;
  };
  const safeSit = () => { try { return situation() ?? {}; } catch { return {}; } };
  const set = (next) => {
    if (state === 'moved' && next !== 'moved' && next !== 'cleared') return; // a moved seat stays said until the page takes it back
    clearTimeout(backTimer);
    clearInterval(tickTimer);
    state = next === 'cleared' ? 'ok' : next;
    if (state === 'lost') lostAt = Date.now();
    if (state === 'lost') tickTimer = setInterval(paint, 1000); // the turn's clock counts down while away
    if (state === 'back') backTimer = setTimeout(() => { state = 'ok'; paint(); }, BACK_MS);
    paint();
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('offline', () => { failures = Math.max(failures, LOST_AFTER); set('lost'); });
    window.addEventListener('online', () => wake());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  }

  return {
    /** A poll that worked. `startedAt`: when it set out; one sent before the loss, or while the browser says it is offline, proves nothing. */
    ok(startedAt = Date.now()) {
      if (state === 'lost' && (startedAt < lostAt || (typeof navigator !== 'undefined' && navigator.onLine === false))) return;
      failures = 0;
      if (state === 'lost') set('back');
      else if (state === 'back') paint();
    },
    failed() {
      failures += 1;
      if (failures >= LOST_AFTER && state !== 'lost' && state !== 'moved') set('lost');
    },
    moved() { if (state !== 'moved') set('moved'); },
    clearMoved() { if (state === 'moved') set('cleared'); },
    get state() { return state; },
  };
}
