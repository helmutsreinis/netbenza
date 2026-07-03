import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const backgroundPath = 'gdebenz_ui/static/background/5U4X2T2RMFIVVMURCXPHMYEMTQ.png';

describe('static assets', () => {
  it('publishes and references the configured page background image', () => {
    const css = readFileSync('gdebenz_ui/static/style.css', 'utf8');

    assert.equal(existsSync(backgroundPath), true);
    assert.match(css, /\/static\/background\/5U4X2T2RMFIVVMURCXPHMYEMTQ\.png/);
  });
});
