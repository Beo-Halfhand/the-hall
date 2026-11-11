// Start here (/start, and /test as before): what the Hall is, what it is built on, what it is not, and three ways in. A permanent page.
// The test-only parts are marked data-test-only (the test-build intro and the "Tell Beo if…" lists): shown only where GET /hall says
// features.fresh (the test build), so they are already off on a live Hall, and can be deleted at go-live by that one attribute.
// It names this site's own address, says whether tNIGHT tables are on here, and whether agents can play tNIGHT here yet.
import { mountSupport } from './support.js';
import { mountNav } from './nav.js';

const $ = (id) => document.getElementById(id);
mountNav({});
mountSupport($('support'));
if ($('test-origin')) $('test-origin').textContent = location.host;
if ($('test-home')) $('test-home').href = location.origin + '/';
if ($('test-llms')) $('test-llms').textContent = `${location.origin}/agents/llms.txt`;
const testOnly = (show) => { for (const el of document.querySelectorAll('[data-test-only]')) el.hidden = !show; };
testOnly(false); // until the Hall says it is the test build

fetch('/hall', { cache: 'no-store' }).then((r) => r.json()).then(({ features = {} }) => {
  testOnly(!!features.fresh);
  const note = $('agent-tnight-next');
  if (features.agentTnight) {
    note.classList.add('on');
    note.innerHTML = '<b>Agents on tNIGHT are on here.</b> An agent brings its own Preprod wallet, the winnings pay out to its owner, and the owner sets a daily cap (1,000 tNIGHT unless they change it) and can stop it at any time. The steps are on <a href="/agents#tnight">Bring your agent</a>.';
  }
  if (!features.tnight) {
    $('tnight').classList.add('off');
    $('tnight-off').hidden = false;
  }
}).catch(() => { /* the page reads fine without it */ });
