// "Support the build" entries, exactly as on the Counter page. A blank address would turn its Copy button off.

export const SUPPORT = [
  { label: "NIGHT or ADA (Cardano)", address: "addr1q84tzwy8280zvgua7t4ds5zr7ucz903x6w4cxcxr6pppyd25yvz9se8vl3rmdy2ecq57e3xnl2khhn3uln8ky6fmhsksq5xk0g" },
  { label: "Private, on Midnight (shielded)", address: "mn_shield-addr14f3gf3j5ve5vjfggv6ky630pex8rv57mg46wctj9elpftr7s2qvd9sdfzdff99wzgfgq8lh4tmcr6mv57yrjnjazp6xlhmpm9wdlu2g7vyjnq" },
];

/** The words on the tap that opens the addresses: real money, so nobody sends the test tokens the tables use. */
export const SUPPORT_NETWORK = 'mainnet NIGHT or ADA (real, not test)';

/** An address as the footer shows it: the start and the end, the middle elided. Copy always copies the whole of it. */
export const shortAddress = (address) => (address.length > 24 ? `${address.slice(0, 12)}…${address.slice(-8)}` : address);

/**
 * Fills a "Support the build" footer (11-08: a slim line, not a box the size of the round record). The title and the
 * lanterns line are in the page; this puts the addresses behind one tap, each shortened on screen, each with a Copy button
 * that copies its exact address. Same on every page.
 */
export function mountSupport(root) {
  if (!root) return;
  const rows = SUPPORT.map((entry) => {
    const row = document.createElement('div');
    row.className = 'support-row';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = entry.label;
    const code = document.createElement('code');
    code.className = 'addr';
    code.textContent = entry.address ? shortAddress(entry.address) : 'Address coming soon';
    if (entry.address) code.title = 'Shortened on screen. Copy copies the whole address.';
    const button = document.createElement('button');
    button.className = 'btn small';
    button.type = 'button';
    button.textContent = 'Copy';
    button.disabled = !entry.address;
    button.dataset.copy = entry.label;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(entry.address);
        button.textContent = 'Copied';
      } catch {
        code.textContent = entry.address; // no clipboard: the whole address, to press and hold
        button.textContent = 'Press and hold to copy';
      }
      setTimeout(() => { button.textContent = 'Copy'; }, 1800);
    });
    row.append(label, code, button);
    return row;
  });
  const open = document.createElement('details');
  open.className = 'support-addresses';
  open.id = 'support-addresses';
  const tap = document.createElement('summary');
  tap.id = 'support-open';
  const what = document.createElement('span');
  what.className = 'support-what';
  what.textContent = 'Addresses';
  const net = document.createElement('span');
  net.className = 'support-net';
  net.id = 'support-net';
  net.textContent = SUPPORT_NETWORK;
  tap.append(what, ' · ', net);
  open.append(tap, ...rows);
  root.replaceChildren(open);
}
