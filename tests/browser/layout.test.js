// Layout: every host and arrow is drawn, coordinates are sane, and the
// number of crossing arrows doesn't regress on the sample graphs.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture, metrics} = require('./harness');

// Upper limits for crossings and lower limits for horizontal arrows, measured
// when these tests were written (1400x800 window). Tighten them when the
// layout improves; a failure here means a change made the layout worse.
const SAMPLES = {
    small: {maxCrossings: 0, minHorizontal: 2},
    parents23: {maxCrossings: 2, minHorizontal: 6},
    // Most hosts here have several parents at different heights, so in this
    // window no arrow comes out exactly level
    random40: {maxCrossings: 13, minHorizontal: 0}
};

for (const [name, limits] of Object.entries(SAMPLES)) {
    test(`layout of the ${name} sample`, async () => {
        const data = fixture(name);
        const {page, errors, close} = await open({data, viewport: {width: 1400, height: 800}});
        try {
            const m = await metrics(page);
            assert.deepEqual(errors, []);
            assert.equal(m.hosts, data.nodes.length, 'every host is drawn');
            assert.ok(m.arrows > 0, 'arrows are drawn');
            assert.ok(m.finite, 'arrow coordinates are finite');
            assert.ok(m.crossings <= limits.maxCrossings, `crossings ${m.crossings} <= ${limits.maxCrossings}`);
            assert.ok(m.horizontal >= limits.minHorizontal, `horizontal arrows ${m.horizontal} >= ${limits.minHorizontal}`);
        } finally {
            await close();
        }
    });
}

test('hosts that are parents of the same children share one box', async () => {
    const {page, close} = await open({data: fixture('parents23')});
    try {
        const boxes = await page.$$eval('.topologygraph-viewport svg rect.topologygraph-box', rects => rects.map(rect => {
            const r = rect.getBoundingClientRect();
            return [...document.querySelectorAll('.topologygraph-viewport svg a')]
                .filter(a => {
                    const c = a.querySelector('circle:last-of-type').getBoundingClientRect();
                    return c.left > r.left && c.right < r.right && c.top > r.top && c.bottom < r.bottom;
                })
                .map(a => a.querySelector('text').textContent).sort().join(',');
        }));
        assert.ok(boxes.includes('checker-a,checker-b,checker-c'), boxes.join(' | '));
        assert.ok(boxes.includes('probe-fra,probe-hkg,probe-tok'), boxes.join(' | '));
    } finally {
        await close();
    }
});
