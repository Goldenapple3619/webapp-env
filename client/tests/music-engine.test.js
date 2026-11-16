const test = require('node:test'), assert = require('node:assert/strict');
const { loadLib, dom } = require('./helpers');

class FakeAudio {
    constructor() { this.handlers = {}; this.loads = []; this.src = ''; this.paused = true; this.currentTime = 0; this.volume = 1; FakeAudio.last = this; }
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }
    removeEventListener(t, fn) { this.handlers[t] = (this.handlers[t] || []).filter(f => f !== fn); }
    removeAttribute() {}
    load() { this.loads.push(this.src); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    fire(t) { (this.handlers[t] || []).slice().forEach(fn => fn({})); }
}
const tick = () => new Promise(r => setImmediate(r));

function engine() {
    const window = dom('<body></body>');
    const fileUrl = p => '/api/my' + p;
    const g = { window, document: window.document, Audio: FakeAudio, localStorage: window.localStorage,
        auth: { fileUrl, refresh: () => Promise.resolve() }, __auth: { getInstance: () => ({ fileUrl, refresh: () => Promise.resolve() }) },
        __ui: { icon: () => '', esc: x => x, el: () => ({}) }, __apps: { getInstance: () => ({}) } };
    window.document.setupApp = {};
    loadLib('apps/musicPlayer/script/main.js', g);
    return { e: window.document.createMusicEngine(() => { }), audio: FakeAudio.last };
}
const tracks = n => Array.from({ length: n }, (_, i) => ({ name: 't' + i, path: `/music/t${i}.mp3` }));

/** one track failing for good: the first error silently retries (after a token refresh), the second gives up on it */
async function failTrack(audio) { audio.fire('error'); await tick(); audio.fire('error'); await tick(); }

/** a dead server: every song fails. Returns how many loads happened before the chain stopped (capped, so a runaway loop cannot hang the test). */
async function failEverything(t, cap = 300) {
    let last = -1;
    while (t.audio.loads.length < cap && t.audio.loads.length !== last) { last = t.audio.loads.length; await failTrack(t.audio); }
    return t.audio.loads.length;
}

test('"repeat all" + a dead server: the skip-on-error chain stops once every song has failed', async () => {
    const t = engine();
    t.e.setQueue(tracks(3), 0, true); t.e.cycleRepeat();
    assert.equal(t.e.getMode().repeat, 'all');
    const loads = await failEverything(t);
    assert.ok(loads <= 3 * 2 + 1, `${loads} loads for 3 songs (initial load + retry each): it must not keep cycling`);
});

test('...also when it starts in the middle, so the queue WRAPS AROUND while failing (the streak must survive the wrap)', async () => {
    const t = engine();
    t.e.setQueue(tracks(3), 2, true); t.e.cycleRepeat();
    const loads = await failEverything(t);
    assert.ok(loads <= 3 * 2 + 1, `${loads} loads`);
});

test('a single broken song is skipped, and once something plays the streak is over', async () => {
    const t = engine();
    t.e.setQueue(tracks(3), 0, true);
    await failTrack(t.audio);
    assert.match(t.audio.src, /t1\.mp3$/, 'moved on to the next song');
    t.audio.fire('playing');
    await failTrack(t.audio);
    assert.match(t.audio.src, /t2\.mp3$/, 'a later failure still skips (the earlier one no longer counts)');
});

test('a new queue, or choosing a song yourself, starts with a clean slate', async () => {
    const t = engine();
    t.e.setQueue(tracks(2), 0, true); t.e.cycleRepeat();
    await failEverything(t);
    const stopped = t.audio.loads.length;
    t.e.setQueue(tracks(2), 0, true);
    assert.equal(t.audio.loads.length, stopped + 1, 'the new queue loads its first song');
    await failTrack(t.audio);
    assert.match(t.audio.src, /t1\.mp3$/, 'and skips on error again');
    await failEverything(t);
    const again = t.audio.loads.length;
    t.e.playIndex(0);
    await failTrack(t.audio);
    assert.ok(t.audio.loads.length > again + 1, 'an explicit choice may skip again too');
});

test('with one song there is nothing to skip to', async () => {
    const t = engine();
    t.e.setQueue(tracks(1), 0, true); t.e.cycleRepeat();
    const loads = await failEverything(t);
    assert.ok(loads <= 2);
});
