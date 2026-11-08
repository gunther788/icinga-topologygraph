// Boxes: hosts without parents grouped by their children (the rightmost
// level), and hosts further left with the same parents and the same children.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture} = require('./harness');

// The siblings sample: web-1..3 share parents lb-1, lb-2 and children
// app-1..3; app-1..3 share parents and children db-main, db-replica; those two
// share parents (and no children). web-4 and lb-1/lb-2 differ, so stand alone.
const SIBLINGS = [['app-1', 'app-2', 'app-3'], ['db-main', 'db-replica'], ['web-1', 'web-2', 'web-3']];

/** Boxes with the hosts drawn inside them, and the arrows with their ends */
const drawing = page => page.evaluate(() => {
    const svg = document.querySelector('.topologygraph-viewport svg');
    const hosts = [...svg.querySelectorAll('a')].map(a => {
        const m = /translate\(([-\d.e]+),([-\d.e]+)\)/.exec(a.getAttribute('transform'));
        return {name: a.querySelector('text').textContent, x: +m[1], y: +m[2]};
    });
    const boxes = [...svg.querySelectorAll('rect.topologygraph-box')].map(r => {
        const b = {x0: +r.getAttribute('x'), y0: +r.getAttribute('y')};
        b.x1 = b.x0 + +r.getAttribute('width');
        b.y1 = b.y0 + +r.getAttribute('height');
        b.names = hosts.filter(h => h.x > b.x0 && h.x < b.x1 && h.y > b.y0 && h.y < b.y1).map(h => h.name).sort();
        return b;
    });
    const arrows = [...svg.querySelectorAll('path[marker-end]')].map(path => {
        const length = path.getTotalLength();
        const end = path.getPointAtLength(length), start = path.getPointAtLength(0);
        return {start: {x: start.x, y: start.y}, end: {x: end.x, y: end.y}, stroke: path.getAttribute('stroke'),
            opacity: path.style.opacity};
    });
    return {hosts, boxes, arrows};
});
const near = (a, b) => Math.abs(a.x - b.x) < 1.5 && Math.abs(a.y - b.y) < 1.5;
const boxWith = (d, names) => d.boxes.find(b => JSON.stringify(b.names) === JSON.stringify(names));
// Arrows ending at the middle of a box's right edge, or leaving from the middle of its left edge
const into = (d, box) => d.arrows.filter(a => near(a.end, {x: box.x1, y: (box.y0 + box.y1) / 2}));
const outOf = (d, box) => d.arrows.filter(a => near(a.start, {x: box.x0, y: (box.y0 + box.y1) / 2}));

for (const layout of ['standard', 'elk', 'hybrid']) {
    test(`${layout}: hosts with the same parents and children share a box, with one arrow per parent and child`, async () => {
        const {page, errors, close} = await open({data: fixture('siblings'), query: layout === 'standard' ? '' : '?layout=' + layout});
        try {
            await page.waitForTimeout(layout === 'standard' ? 0 : 800);
            const d = await drawing(page);
            for (const names of SIBLINGS) {
                const box = boxWith(d, names);
                assert.ok(box, `${names.join(', ')} boxed together`);
                const members = d.hosts.filter(h => names.includes(h.name));
                assert.ok(members.every(h => Math.abs(h.x - members[0].x) < 0.5), 'in one column');
                const ys = members.map(h => h.y).sort((a, b) => a - b);
                // One row apart (rows are 24px, stretched up to 1.25x when there is room)
                const step = ys[1] - ys[0];
                assert.ok(step >= 23.5 && step <= 30.5 && ys.every((y, i) => !i || Math.abs(y - ys[i - 1] - step) < 0.5),
                    'on consecutive rows');
            }
            assert.equal(into(d, boxWith(d, SIBLINGS[2])).length, 2, 'web box: one arrow from lb-1, one from lb-2');
            assert.equal(outOf(d, boxWith(d, SIBLINGS[2])).length, 1, 'web box: one arrow to the app box');
            assert.equal(into(d, boxWith(d, SIBLINGS[0])).length, 1, 'app box: one arrow in');
            assert.equal(into(d, boxWith(d, SIBLINGS[1])).length, 1, 'db box: one arrow in');
            assert.equal(d.arrows.length, 13, 'one arrow per pair of boxes or hosts (the data has 30 links)');
            assert.ok(!boxWith(d, ['lb-1', 'lb-2']), 'lb-1 and lb-2 have different children: no box');
            assert.equal(d.boxes.length, 6, 'three sibling boxes and three rightmost boxes');
            assert.deepEqual(errors, []);
        } finally {
            await close();
        }
    });
}

test('a down host in a box colours the arrow into the box', async () => {
    const data = fixture('siblings');
    data.nodes.find(n => n.name === 'app-2').state = 1;
    const {page, close} = await open({data});
    try {
        const d = await drawing(page);
        const arrows = into(d, boxWith(d, SIBLINGS[0]));
        assert.equal(arrows.length, 1);
        assert.equal(arrows[0].stroke, '#ff5566');
        assert.ok(outOf(d, boxWith(d, SIBLINGS[0])).every(a => a.stroke !== '#ff5566'), 'arrows out of it are not');
    } finally {
        await close();
    }
});

test('hovering a host in a box highlights the arrows into and out of the box', async () => {
    const {page, close} = await open({data: fixture('siblings')});
    try {
        await page.hover('.topologygraph-viewport a[href="#app-2"] circle:last-of-type');
        await page.waitForTimeout(100);
        const d = await drawing(page);
        const app = boxWith(d, SIBLINGS[0]);
        assert.ok(into(d, app).concat(outOf(d, app)).every(a => a.opacity === '1'), 'on the chain');
        const cacheArrows = d.arrows.filter(a => near(a.end, d.hosts.find(h => h.name === 'cache')));
        assert.ok(cacheArrows.length && cacheArrows.every(a => a.opacity !== '1'), 'other arrows are dimmed');
    } finally {
        await close();
    }
});
