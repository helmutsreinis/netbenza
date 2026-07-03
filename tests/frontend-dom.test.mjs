import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it } from 'node:test';

import { JSDOM } from 'jsdom';

function loadFrontendHarness() {
  const dom = new JSDOM(`
    <!doctype html>
    <button id="vote-btn">Vote (<span id="vote-count">0</span>)</button>
    <select id="vote-status"><option value=""></option><option value="yes">yes</option></select>
    <div id="stats-selected"></div>
  `, { url: 'http://localhost/' });
  const source = readFileSync('gdebenz_ui/static/app.js', 'utf8').replace(/\ninit\(\);\s*$/, '\n');
  const context = vm.createContext({
    clearInterval,
    clearTimeout,
    console,
    crypto,
    document: dom.window.document,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    Headers,
    localStorage: dom.window.localStorage,
    setInterval,
    setTimeout,
    URLSearchParams,
    window: dom.window,
  });

  vm.runInContext(source, context);
  return { context, dom };
}

describe('frontend DOM updates', () => {
  it('keeps the vote-count element after updating vote button text', () => {
    const { context, dom } = loadFrontendHarness();

    vm.runInContext(`
      state.totalFiltered = 12;
      state.allSelected.add('one');
      document.getElementById('vote-status').value = 'yes';
      updateSelectedCount();
      updateVoteBtn();
      state.allSelected.add('two');
      updateSelectedCount();
    `, context);

    assert.equal(dom.window.document.getElementById('vote-count')?.textContent, '2');
    assert.match(dom.window.document.getElementById('vote-btn')?.textContent || '', /12 filtered/);
  });
});
