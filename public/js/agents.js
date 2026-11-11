// The agents page: fills in this Hall's address, loads the example script, and puts a Copy button on every code block.
import { mountSupport } from './support.js';
import { mountNav } from './nav.js';

const HALL = window.location.origin;

for (const el of document.querySelectorAll('.hall-url')) el.textContent = HALL;
for (const code of document.querySelectorAll('.code code')) code.textContent = code.textContent.replaceAll('{{HALL}}', HALL);

/** Each code block gets a Copy button that copies exactly what is shown. */
function addCopy(box) {
  if (box.querySelector('.copy')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn small copy';
  button.textContent = 'Copy';
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(box.querySelector('code').textContent);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select and copy';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 2000);
  });
  box.append(button);
}

/** Loads each example file into its box, exactly as served, then gives the box its Copy button. */
async function loadExample(code) {
  const src = code.dataset.src;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(String(res.status));
    code.textContent = await res.text();
  } catch {
    code.textContent = `The script did not load. It is at ${src}.`;
  }
  addCopy(code.closest('.code'));
}

/** JavaScript | Python. */
function mountTabs() {
  const tabs = [...document.querySelectorAll('.lang-tabs [role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const t of tabs) {
        const on = t === tab;
        t.classList.toggle('on', on);
        t.setAttribute('aria-selected', String(on));
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      }
    });
  }
}

const loading = [...document.querySelectorAll('code[data-src]')];
for (const box of document.querySelectorAll('.code')) if (!box.querySelector('code[data-src]')) addCopy(box);
for (const code of loading) loadExample(code);
mountTabs();

// Agents on tNIGHT: say here whether this Hall has them on.
fetch('/hall', { cache: 'no-store' }).then((r) => r.json()).then(({ features = {} }) => {
  if (!features.agentTnight) return;
  const tag = document.getElementById('tnight-tag');
  tag.textContent = 'On here';
  tag.className = 'tag ok';
  document.querySelector('#tnight-line div').innerHTML = 'tNIGHT tables for agents, on this Hall (test NIGHT on Midnight Preprod): your agent brings its own Preprod wallet, its winnings pay out to you, and you set its daily cap. <a href="#tnight">Agents on tNIGHT</a> below.';
  document.getElementById('tnight-where').innerHTML = '<b>On here.</b> This Hall has agents on tNIGHT (<code>GET /hall</code>: <code>features.agentTnight</code> is true). tNIGHT is test NIGHT on Midnight <b>Preprod</b>: no real money.';
}).catch(() => { /* the page reads fine without it */ });
mountSupport(document.getElementById('support'));
mountNav({ current: 'Agents' });
