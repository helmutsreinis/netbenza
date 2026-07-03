import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const backgroundPath = 'gdebenz_ui/static/background/5U4X2T2RMFIVVMURCXPHMYEMTQ.png';

describe('static assets', () => {
  it('publishes and references the configured page background image', () => {
    const css = readFileSync('gdebenz_ui/static/style.css', 'utf8');
    const html = readFileSync('gdebenz_ui/static/index.html', 'utf8');

    assert.equal(existsSync(backgroundPath), true);
    assert.match(html, /class="site-background"/);
    assert.match(css, /\/static\/background\/5U4X2T2RMFIVVMURCXPHMYEMTQ\.png/);
    assert.match(css, /\.site-background\s*\{/);
    assert.match(css, /position:\s*fixed/);
    assert.match(css, /inset:\s*0/);
    assert.match(css, /background:[^}]*center\s*\/\s*100%\s+100%\s*no-repeat/s);
  });

  it('uses a 7 km default station search radius', () => {
    const html = readFileSync('gdebenz_ui/static/index.html', 'utf8');
    const app = readFileSync('gdebenz_ui/static/app.js', 'utf8');

    assert.match(html, /id="radius-input"[^>]*value="7"/);
    assert.match(app, /const radius = \$\('#radius-input'\)\.value \|\| '7';/);
  });

  it('keeps the side map from squeezing the station list', () => {
    const css = readFileSync('gdebenz_ui/static/style.css', 'utf8');

    assert.match(css, /main\s*\{[^}]*max-width:\s*1180px/s);
    assert.match(css, /\.results-layout\s*\{[^}]*grid-template-columns:\s*minmax\(640px,\s*1fr\)\s+minmax\(280px,\s*340px\)/s);
  });

  it('renders map pins as large visible blocks', () => {
    const css = readFileSync('gdebenz_ui/static/style.css', 'utf8');

    assert.match(css, /\.result-map-marker\s*\{[^}]*display:\s*block/s);
    assert.match(css, /\.result-map-marker\s*\{[^}]*width:\s*24px\s*!important/s);
    assert.match(css, /\.result-map-marker\s*\{[^}]*height:\s*24px\s*!important/s);
  });
});
