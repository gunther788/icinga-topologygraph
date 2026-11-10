(function (Icinga) {


    var Topologygraph = function (module) {
        this.module = module;
        this.initialize();
        this.module.icinga.logger.debug('Topologygraph module loaded');
    };

    function rgbToHex(rgb) {
        const match = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) {
            return null;
        }
        const toHex = (n) => ('0' + parseInt(n).toString(16)).slice(-2);
        return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
    }

    // Colours as Icinga Web uses them
    const COLOURS = {
        up: "#44bb77",
        down: "#ff5566",
        unreachable: "#aa44ff",
        pending: "#77aaff",
        unknownHost: "#dbdbdb",
        warning: "#ffaa44",
        critical: "#ff5566",
        unknown: "#aa44ff",
        edge: "#00c3ed",
        // Arrows with a host outside the group at either end: a gray with the
        // same lightness (relative luminance) as the blue above, drawn at the
        // same width and opacity, so neither looks bolder
        edgeOutside: "#adb3bc"
    };

    function stateName(node) {
        if (node.state === null || node.state === undefined) return "unknown";
        if (!node.last_check || node.last_check <= 0) return "pending";
        if (node.state === 0) return "up";
        // Down only because a parent is down
        return node.reachable === false ? "unreachable" : "down";
    }

    function stateColor(node) {
        switch (stateName(node)) {
            case "up": return COLOURS.up;
            case "down": return COLOURS.down;
            case "unreachable": return COLOURS.unreachable;
            case "pending": return COLOURS.pending;
            default: return COLOURS.unknownHost;
        }
    }

    // A host problem (down or unreachable)
    function isProblem(node) {
        const state = stateName(node);
        return state === "down" || state === "unreachable";
    }

    // A problem someone already knows about: acknowledged or in downtime
    function isHandled(node) {
        return isProblem(node) && !!(node.acknowledged || node.in_downtime);
    }

    // Synthetic hosts aggregating others (vars.synthetic.members and .mode):
    // "2 of 3 · 2 up" -- members needed of all, and how many are up
    function aggregateText(aggregate, upCount = aggregate.up.length) {
        const needed = aggregate.needed === null ? aggregate.total + " members" : aggregate.needed + " of " + aggregate.total;
        return needed + " \u00b7 " + upCount + " up";
    }

    // ok: every member up; degraded: some aren't, but enough are; failed:
    // fewer are up than needed
    function aggregateHealth(aggregate) {
        const up = aggregate.up.length;
        if (up === aggregate.total) return "ok";
        if (aggregate.needed !== null && up < aggregate.needed) return "failed";
        return "degraded";
    }

    // Room for the badge left of a synthetic host's name, at its widest
    const BADGE_FONT = 10;
    const BADGE_GAP = 6;
    function badgeWidth(ctx, aggregate) {
        ctx.font = BADGE_FONT + "px sans-serif";
        return ctx.measureText(aggregateText(aggregate, aggregate.total)).width + 8;
    }

    // One line describing a host's services for the hover text; notifiedOnly
    // when services with notifications disabled are left out
    function servicesText(services, notifiedOnly) {
        const what = notifiedOnly ? "services with notifications" : "services";
        if (services === null || services === undefined) return "services: not available";
        if (!services.total) return what + ": none";
        const parts = ["critical", "warning", "unknown", "pending"]
            .filter(state => services[state])
            .map(state => services[state] + " " + state);
        const problems = services.critical + services.warning + services.unknown;
        if (problems > services.unhandled) parts.push((problems - services.unhandled) + " handled");
        return what + ": " + services.total + (parts.length ? " (" + parts.join(", ") + ")" : ", all OK");
    }

    // How often to fetch fresh host states while the page is visible, unless
    // the server says otherwise (the module's "Refresh interval" setting)
    const REFRESH_MS = 15000;
    const refreshInterval = data => data && data.refresh >= 5 ? data.refresh * 1000 : REFRESH_MS;

    /**
     * Everything that affects the layout (hosts, their labels and group
     * membership, and the dependencies), but not host states. If this is
     * unchanged, a refresh only needs to recolour the existing drawing.
     */
    function structureOf(data) {
        const nodes = (data.nodes || []).map(n => [
            n.name, n.label, !!(n.member !== undefined ? n.member : n.synthetic), n.link,
            n.aggregate ? [n.aggregate.mode, n.aggregate.needed, n.aggregate.members] : null
        ]).sort();
        const links = (data.links || []).map(l => [l.source, l.target]).sort();
        return JSON.stringify([nodes, links]);
    }

    /**
     * Lay out a directed acyclic graph in columns (parents left, children right).
     *
     * Each node's column is the length of the longest parent chain above it, so a
     * host with several parents always sits to the right of all of them. Rows are
     * ordered with a few barycenter sweeps to reduce crossing edges.
     */
    function layout(nodes, links) {
        const byName = new Map(nodes.map(n => [n.name, n]));
        const parents = new Map(nodes.map(n => [n.name, []]));
        const children = new Map(nodes.map(n => [n.name, []]));
        const indegree = new Map(nodes.map(n => [n.name, 0]));

        links.forEach(l => {
            if (!byName.has(l.source) || !byName.has(l.target)) return;
            children.get(l.source).push(l.target);
            parents.get(l.target).push(l.source);
            indegree.set(l.target, indegree.get(l.target) + 1);
        });

        // Longest-path layering via Kahn's topological sort
        const layer = new Map(nodes.map(n => [n.name, 0]));
        const queue = nodes.filter(n => indegree.get(n.name) === 0).map(n => n.name);
        const seen = new Set();
        while (queue.length) {
            const name = queue.shift();
            seen.add(name);
            children.get(name).forEach(child => {
                layer.set(child, Math.max(layer.get(child), layer.get(name) + 1));
                indegree.set(child, indegree.get(child) - 1);
                if (indegree.get(child) === 0) queue.push(child);
            });
        }
        // Icinga rejects dependency cycles, but don't hang or drop nodes if one slips through
        nodes.forEach(n => {
            if (!seen.has(n.name)) {
                const maxParent = Math.max(-1, ...parents.get(n.name).filter(p => seen.has(p)).map(p => layer.get(p)));
                layer.set(n.name, maxParent + 1);
            }
        });

        const layerCount = Math.max(0, ...layer.values()) + 1;
        const columns = Array.from({length: layerCount}, () => []);
        nodes
            .slice()
            .sort((a, b) => d3.ascending(a.label, b.label))
            .forEach(n => columns[layer.get(n.name)].push(n.name));

        const position = new Map();
        const reindex = () => columns.forEach(col => col.forEach((name, i) => position.set(name, i)));
        reindex();

        const barycenter = (name, neighbours) => {
            const list = neighbours.get(name);
            if (!list.length) return position.get(name);
            return d3.mean(list, n => position.get(n));
        };

        for (let sweep = 0; sweep < 4; sweep++) {
            for (let i = 1; i < layerCount; i++) {
                columns[i].sort((a, b) => barycenter(a, parents) - barycenter(b, parents));
                columns[i].forEach((name, idx) => position.set(name, idx));
            }
            for (let i = layerCount - 2; i >= 0; i--) {
                columns[i].sort((a, b) => barycenter(a, children) - barycenter(b, children));
                columns[i].forEach((name, idx) => position.set(name, idx));
            }
        }

        return {columns, layer, position, layerCount};
    }

    /**
     * Hosts that have parents and share exactly the same parents and the same
     * children with at least one other host: drawn together in one box, with
     * one arrow from each parent into the box and one from the box to each
     * child. Returns arrays of names, each sorted.
     */
    function siblingGroups(names, parentsOf, childrenOf) {
        const byKey = new Map();
        names.forEach(name => {
            const parents = parentsOf.get(name) || [];
            if (!parents.length) return;
            const key = parents.slice().sort().join("\0") + "\u0001" + (childrenOf.get(name) || []).slice().sort().join("\0");
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(name);
        });
        return [...byKey.values()].filter(group => group.length > 1).map(group => group.sort((a, b) => d3.ascending(a, b)));
    }

    // Drawing constants. BASE spacing is the tightest layout; it is widened to
    // fill the window when there is room (see computeLayout).
    const FONT_SIZE = 12;
    const BASE = {rowHeight: 24, columnGap: 90, subColumnGap: 40};
    const PADDING = 16;
    const LABEL_OFFSET = 10; // circle centre to the end of its label (labels sit left of the dot)
    const BOX_PAD_X = 6;

    /**
     * Place a column of hosts (in this order) as close as possible to their
     * target heights, keeping at least `gap` between neighbours: least squares
     * under the ordering constraint, solved by pool-adjacent-violators on
     * y[i] - i * gap. gap can also be an array of each host's minimum offset
     * from the first one, for uneven gaps. The result is shifted to stay
     * within [lo, hi] if it can.
     */
    function alignColumn(targets, gap, lo, hi) {
        const off = i => Array.isArray(gap) ? gap[i] : i * gap;
        const blocks = [];
        targets.forEach((t, i) => {
            blocks.push({sum: t - off(i), count: 1});
            while (blocks.length > 1) {
                const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
                if (a.sum / a.count <= b.sum / b.count) break;
                blocks.pop();
                a.sum += b.sum;
                a.count += b.count;
            }
        });
        const ys = [];
        blocks.forEach(b => {
            for (let k = 0; k < b.count; k++) ys.push(b.sum / b.count + off(ys.length));
        });
        if (!ys.length) return ys;
        let shift = 0;
        if (ys[0] < lo) shift = lo - ys[0];
        else if (ys[ys.length - 1] > hi) shift = Math.max(lo - ys[0], hi - ys[ys.length - 1]);
        return ys.map(y => y + shift);
    }

    /**
     * Lay out the graph for a viewport of size avail ({width, height}).
     *
     * Hosts keep their dependency level (column). The rightmost level (hosts
     * with no parents) is wrapped into side-by-side sub-columns, with hosts that
     * are parents of the same children kept together as one boxed group.
     * Further left, hosts with the same parents and children are boxed too
     * (see siblingGroups) and move as one block. The
     * height of those sub-columns is chosen so the diagram's shape matches the
     * viewport's, then rows are ordered to minimise crossing arrows, and finally
     * the gaps are widened so the diagram fills the viewport at 100%.
     *
     * Returns {coords, boxes, edges, width, height, top}.
     */
    function computeLayout(nodes, links, avail) {
        const {columns, layerCount} = layout(nodes, links);

        const nodeNames = new Set(nodes.map(n => n.name));
        const validLinks = links.filter(l => nodeNames.has(l.source) && nodeNames.has(l.target));
        const childrenOf = new Map(nodes.map(n => [n.name, []]));
        const parentsOf = new Map(nodes.map(n => [n.name, []]));
        validLinks.forEach(l => {
            childrenOf.get(l.source).push(l.target);
            parentsOf.get(l.target).push(l.source);
        });
        const rightmost = new Set(columns[0]);
        // Hosts further left with the same parents and children share a box
        const siblingOf = new Map();
        siblingGroups(nodes.map(n => n.name), parentsOf, childrenOf).forEach(names => {
            const group = {names, children: childrenOf.get(names[0]).slice()};
            names.forEach(name => siblingOf.set(name, group));
        });
        // Keep each sibling group together in a level's row order
        const cluster = names => {
            const out = [];
            const done = new Set();
            names.forEach(name => {
                const group = siblingOf.get(name);
                if (!group) out.push(name);
                else if (!done.has(group)) {
                    done.add(group);
                    out.push(...group.names);
                }
            });
            return out;
        };

        // Measure labels so each column leaves room for its text
        const labelWidth = measureLabels(nodes);
        const widest = names => Math.max(0, ...names.map(name => labelWidth.get(name)));

        // Rightmost hosts grouped by their exact set of children
        const groupsByKey = new Map();
        columns[0].forEach(name => {
            const key = childrenOf.get(name).slice().sort().join("\0");
            if (!groupsByKey.has(key)) groupsByKey.set(key, []);
            groupsByKey.get(key).push(name);
        });
        const rawGroups = [];
        let looseNames = [];
        groupsByKey.forEach((names, key) => {
            names.sort((a, b) => d3.ascending(a, b));
            if (key === "") {
                looseNames = names;
            } else {
                rawGroups.push({names, children: key.split("\0")});
            }
        });

        // Choose the height of the rightmost sub-columns (in rows). Estimate the
        // diagram's size for each candidate and take the one that shows it
        // largest (up to 100%) in the viewport; among those that fit at 100%,
        // the one whose shape is closest to the viewport's.
        const otherMax = Math.max(0, ...columns.slice(1).map(c => c.length));
        let leftWidth = 0;
        for (let col = layerCount - 1; col >= 1; col--) {
            leftWidth += widest(columns[col]) + LABEL_OFFSET + BASE.columnGap;
        }
        const estimate = rows => {
            const subs = [];
            let current = null;
            rawGroups.forEach(group => {
                for (let i = 0; i < group.names.length; i += rows) {
                    const piece = group.names.slice(i, i + rows);
                    const need = (current && current.used ? 1 : 0) + piece.length;
                    if (!current || current.used + need > rows) {
                        current = {used: 0, names: []};
                        subs.push(current);
                    }
                    current.used += current.used ? 1 + piece.length : piece.length;
                    current.names.push(...piece);
                }
            });
            for (let i = 0; i < looseNames.length; i += rows) {
                const chunk = looseNames.slice(i, i + rows);
                subs.push({used: chunk.length, names: chunk});
            }
            const rightWidth = d3.sum(subs, s => widest(s.names) + LABEL_OFFSET)
                + Math.max(0, subs.length - 1) * BASE.subColumnGap;
            const usedRows = Math.max(otherMax, ...subs.map(s => s.used));
            return {
                linkedSubColumns: subs.length - Math.ceil(looseNames.length / rows),
                width: PADDING + leftWidth + rightWidth + 5 + BOX_PAD_X + PADDING,
                height: 2 * PADDING + Math.max(0, usedRows - 1) * BASE.rowHeight + 8
            };
        };
        const neededRows = d3.sum(rawGroups, g => g.names.length) + Math.max(0, rawGroups.length - 1);
        const lowest = Math.max(layerCount > 1 ? otherMax : 1, 2);
        const highest = Math.min(Math.max(lowest, neededRows, looseNames.length), lowest + 400);
        let maxRows = lowest;
        if (avail && avail.width > 0 && avail.height > 0) {
            const targetAspect = avail.width / avail.height;
            let best = null;
            for (let rows = lowest; rows <= highest; rows++) {
                const e = estimate(rows);
                const scale = Math.min(1, avail.width / e.width, avail.height / e.height);
                const aspectError = Math.abs(Math.log((e.width / e.height) / targetAspect));
                if (!best || scale > best.scale + 1e-6
                    || (Math.abs(scale - best.scale) <= 1e-6 && aspectError < best.aspectError)) {
                    best = {rows, scale, aspectError};
                }
            }
            maxRows = best.rows;
        } else {
            maxRows = layerCount > 1 ? Math.max(otherMax, 8) : Math.max(8, Math.ceil(columns[0].length / 4));
        }
        // Keep to the planned number of sub-columns so the diagram keeps the
        // chosen shape; a group may only open another if it fits nowhere else
        const subColumnLimit = Math.max(1, estimate(maxRows).linkedSubColumns);

        // Groups taller than a sub-column are split into pieces, one box each
        const linkedGroups = [];
        rawGroups.forEach(group => {
            for (let i = 0; i < group.names.length; i += maxRows) {
                linkedGroups.push({names: group.names.slice(i, i + maxRows), children: group.children});
            }
        });

        /**
         * Compute the full drawing for a given row order of the left levels
         * (order[i] lists the hosts of level i, for i >= 1): host positions,
         * boxes and edges. Levels keep their columns; only rows change.
         * spread is the cost of putting a rightmost group one sub-column
         * further out, against moving it one row from its children's height.
         * pinned optionally fixes some rightmost groups at {k, start}.
         * sp is the spacing ({rowHeight, columnGap, subColumnGap}).
         */
        const place = (rawOrder, spread = 1.5, pinned = null, sp = BASE) => {
            const order = rawOrder.map((names, col) => col ? cluster(names) : names);
            const rowY = row => PADDING + row * sp.rowHeight;
            const coords = new Map();
            let x = PADDING;

            // Left levels: deepest first, each starting centred against maxRows
            for (let col = layerCount - 1; col >= 1; col--) {
                x += widest(order[col]) + LABEL_OFFSET;
                const offset = (maxRows - order[col].length) / 2;
                order[col].forEach((name, i) => coords.set(name, {x, y: rowY(offset + i)}));
                x += sp.columnGap;
            }

            // Keep arrows horizontal: move each left host towards the (median)
            // height of the hosts it connects to (anchorOf gives where a
            // neighbour's arrows start or end), keeping the row order and at
            // least one row between hosts. Alternate directions a few times so
            // alignment can travel along chains.
            const alignLeft = (hostAnchor, rounds) => {
                const lo = rowY(0), hi = rowY(maxRows - 1);
                // A sibling group's arrows meet at the middle of its box
                const middleOf = (group, at) => d3.mean(group.names, at);
                const anchorOf = name => siblingOf.has(name) ? middleOf(siblingOf.get(name), hostAnchor) : hostAnchor(name);
                const target = name => {
                    const ys = parentsOf.get(name).concat(childrenOf.get(name))
                        .map(anchorOf).filter(y => y !== undefined);
                    // Line the host up exactly with one neighbour: the median, or
                    // with an even count whichever middle value is nearer to where
                    // the host is now (an average would slope all of its arrows).
                    // Siblings all aim for the same height, so they stay together.
                    const own = siblingOf.has(name) ? middleOf(siblingOf.get(name), n => coords.get(n).y) : coords.get(name).y;
                    if (!ys.length) return own;
                    ys.sort((a, b) => a - b);
                    const mid = ys.length >> 1;
                    if (ys.length % 2) return ys[mid];
                    return Math.abs(ys[mid - 1] - own) <= Math.abs(ys[mid] - own) ? ys[mid - 1] : ys[mid];
                };
                const alignOne = col => {
                    // Half a row extra around each sibling box keeps it clear of its neighbours
                    const offsets = [];
                    order[col].forEach((name, i) => {
                        let offset = i ? offsets[i - 1] + sp.rowHeight : 0;
                        const before = i ? siblingOf.get(order[col][i - 1]) : undefined, here = siblingOf.get(name);
                        if (i && before !== here && (before || here)) offset += sp.rowHeight / 2;
                        offsets.push(offset);
                    });
                    const ys = alignColumn(order[col].map(target), offsets, lo, hi);
                    order[col].forEach((name, i) => coords.get(name).y = ys[i]);
                };
                for (let round = 0; round < rounds; round++) {
                    for (let col = 1; col < layerCount; col++) alignOne(col);
                    for (let col = layerCount - 1; col >= 1; col--) alignOne(col);
                }
            };
            // First among the left levels only (rightmost groups aren't placed yet)
            alignLeft(name => rightmost.has(name) ? undefined : coords.get(name).y, 3);

            // Rightmost level: put each group at the height of its children,
            // in whichever sub-column lets it sit closest to that height
            linkedGroups.forEach(group => {
                const meanY = d3.mean(group.children, child => coords.get(child).y);
                group.desired = (meanY - PADDING) / sp.rowHeight - (group.names.length - 1) / 2;
            });
            // A sub-column tracks which rows are taken; a group needs its own
            // rows plus a free row above and below to keep boxes apart.
            const subColumns = [];
            const newSub = () => ({taken: new Array(maxRows).fill(false), groups: []});
            const fits = (column, start, size) => {
                if (start < 0 || start + size > maxRows) return false;
                for (let r = Math.max(0, start - 1); r <= Math.min(maxRows - 1, start + size); r++) {
                    if (column.taken[r]) return false;
                }
                return true;
            };
            const put = (k, group, start) => {
                while (subColumns.length <= k) subColumns.push(newSub());
                const column = subColumns[k];
                for (let r = start; r < start + group.names.length; r++) column.taken[r] = true;
                column.groups.push({group, start});
            };

            // Groups with a position chosen by the final refinement go first
            const pending = [];
            linkedGroups.forEach(group => {
                const fixed = pinned && pinned.get(group);
                if (fixed && fits(subColumns[fixed.k] || newSub(), fixed.start, group.names.length)) {
                    put(fixed.k, group, fixed.start);
                } else {
                    pending.push(group);
                }
            });
            pending
                .sort((a, b) => a.desired - b.desired)
                .forEach(group => {
                    const size = group.names.length;
                    const search = limit => {
                        let best = null;
                        for (let k = 0; k <= Math.min(subColumns.length, limit - 1); k++) {
                            const column = subColumns[k] || newSub();
                            for (let start = 0; start + size <= maxRows; start++) {
                                if (!fits(column, start, size)) continue;
                                // Further sub-columns mean longer edges across more boxes
                                const cost = Math.abs(start - group.desired) + k * spread;
                                if (!best || cost < best.cost) best = {k, start, cost};
                            }
                        }
                        return best;
                    };
                    const best = search(subColumnLimit) || search(Infinity);
                    put(best.k, group, best.start);
                });
            // Drop sub-columns left empty by pinned positions
            for (let k = subColumns.length - 1; k >= 0; k--) {
                if (!subColumns[k].groups.length) subColumns.splice(k, 1);
            }
            linkedGroups.forEach(group => group.placed = null);
            subColumns.forEach((column, k) => column.groups.forEach(g => g.group.placed = {k, start: g.start}));

            // Then line the left levels up with the boxes that now point at them
            // (a box's arrows leave from its middle)
            // (a box's arrows leave from its middle). Boxes sit on the row grid;
            // first let each one slide up to 0.4 of a row towards the median
            // height of its children, so a single arrow can come out level. The
            // blank row between boxes keeps them apart.
            const boxMiddle = new Map();
            subColumns.forEach(column => column.groups.forEach(placedGroup => {
                const {group, start} = placedGroup;
                const middle = rowY(start + (group.names.length - 1) / 2);
                const want = d3.median(group.children, child => coords.get(child).y);
                const limit = 0.4 * sp.rowHeight;
                placedGroup.offset = Math.max(-limit, Math.min(limit, want - middle));
                group.names.forEach(name => boxMiddle.set(name, middle + placedGroup.offset));
            }));
            alignLeft(name => rightmost.has(name) ? boxMiddle.get(name) : coords.get(name).y, 2);

            // Hosts with no children go last, in sub-columns of their own
            for (let i = 0; i < looseNames.length; i += maxRows) {
                const names = looseNames.slice(i, i + maxRows);
                subColumns.push({
                    groups: [{group: {names, children: []}, start: Math.floor((maxRows - names.length) / 2)}]
                });
            }

            const boxes = [];
            subColumns.forEach((column, k) => {
                if (k > 0) x += sp.subColumnGap;
                x += widest([].concat(...column.groups.map(g => g.group.names))) + LABEL_OFFSET;
                column.groups.forEach(({group, start, offset = 0}) => {
                    group.names.forEach((name, i) => coords.set(name, {x, y: rowY(start + i) + offset}));
                    boxes.push({
                        names: group.names,
                        children: group.children,
                        x0: x - LABEL_OFFSET - widest(group.names) - BOX_PAD_X,
                        x1: x + 5 + BOX_PAD_X,
                        y0: rowY(start) + offset - BASE.rowHeight / 2 + 2,
                        y1: rowY(start + group.names.length - 1) + offset + BASE.rowHeight / 2 - 2
                    });
                });
            });

            // Sibling groups further left
            const seenSiblings = new Set();
            siblingOf.forEach(group => {
                if (seenSiblings.has(group)) return;
                seenSiblings.add(group);
                const ys = group.names.map(name => coords.get(name).y);
                const x = coords.get(group.names[0]).x;
                boxes.push({
                    names: group.names,
                    children: group.children,
                    sibling: true,
                    x0: x - LABEL_OFFSET - widest(group.names) - BOX_PAD_X,
                    x1: x + 5 + BOX_PAD_X,
                    y0: Math.min(...ys) - sp.rowHeight / 2 + 2,
                    y1: Math.max(...ys) + sp.rowHeight / 2 - 2
                });
            });

            // Edges leave from the far (left) end of the parent's label, or from
            // the box it is in, and run left into the child's dot, or into the
            // box it is in. One edge per box, whichever of its hosts it is for.
            const boxOf = new Map();
            boxes.forEach(box => box.names.forEach(name => boxOf.set(name, box)));
            const edgeMap = new Map();
            validLinks.forEach(l => {
                const from = boxOf.get(l.source) || l.source, to = siblingOf.has(l.target) ? boxOf.get(l.target) : l.target;
                if (!edgeMap.has(from)) edgeMap.set(from, new Map());
                if (edgeMap.get(from).has(to)) return;
                const p = coords.get(l.source);
                const children = typeof to === "string" ? [to] : to.names;
                edgeMap.get(from).set(to, {
                    source: typeof from === "string"
                        ? {x: p.x - LABEL_OFFSET - labelWidth.get(l.source) - 5, y: p.y}
                        : {x: from.x0, y: (from.y0 + from.y1) / 2},
                    target: typeof to === "string" ? coords.get(to) : {x: to.x1, y: (to.y0 + to.y1) / 2},
                    child: children[0],
                    children,
                    parents: typeof from === "string" ? [from] : from.names
                });
            });
            const edges = [];
            edgeMap.forEach(targets => targets.forEach(edge => edges.push(edge)));

            // Where each host's edges start, for ordering its children
            const anchorY = new Map();
            coords.forEach((p, name) => anchorY.set(name, p.y));
            boxes.forEach(box => box.names.forEach(name => anchorY.set(name, (box.y0 + box.y1) / 2)));

            return {
                coords, boxes, edges, anchorY,
                subColumnCount: subColumns.length,
                width: x + 5 + BOX_PAD_X + PADDING
            };
        };

        // Count crossing edges, treating each as a straight line (the drawn
        // curves cross in the same places). Edges sharing an end can't cross.
        const crossings = edges => {
            let count = 0;
            const same = (a, b) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
            const yAt = (e, x) => e.source.y + (e.target.y - e.source.y) * (x - e.source.x) / (e.target.x - e.source.x);
            for (let i = 0; i < edges.length; i++) {
                for (let j = i + 1; j < edges.length; j++) {
                    const a = edges[i], b = edges[j];
                    if (same(a.source, b.source) || same(a.target, b.target)) continue;
                    const lo = Math.max(a.target.x, b.target.x);
                    const hi = Math.min(a.source.x, b.source.x);
                    if (hi - lo < 1) continue;
                    if ((yAt(a, lo) - yAt(b, lo)) * (yAt(a, hi) - yAt(b, hi)) < 0) count++;
                }
            }
            return count;
        };
        // Count edges that run through a box or a host label they don't belong
        // to; that hides text just as badly as a crossing does.
        const obstacleHits = geo => {
            const obstacles = geo.boxes.map(b => ({x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1}));
            geo.coords.forEach((p, name) => {
                if (rightmost.has(name) || siblingOf.has(name)) return; // already inside a box
                obstacles.push({
                    x0: p.x - LABEL_OFFSET - labelWidth.get(name), x1: p.x + 5,
                    y0: p.y - BASE.rowHeight / 2 + 5, y1: p.y + BASE.rowHeight / 2 - 5
                });
            });
            let count = 0;
            geo.edges.forEach(e => {
                obstacles.forEach(o => {
                    const lo = Math.max(o.x0, e.target.x + 6), hi = Math.min(o.x1, e.source.x - 1);
                    if (hi <= lo) return;
                    const yA = e.source.y + (e.target.y - e.source.y) * (lo - e.source.x) / (e.target.x - e.source.x);
                    const yB = e.source.y + (e.target.y - e.source.y) * (hi - e.source.x) / (e.target.x - e.source.x);
                    if (Math.max(yA, yB) > o.y0 && Math.min(yA, yB) < o.y1) count++;
                });
            });
            return count;
        };
        // Fewest crossings and hidden labels first; among equals, prefer
        // shorter vertical runs
        const score = geo => (crossings(geo.edges) + obstacleHits(geo)) * 1e6
            + d3.sum(geo.edges, e => Math.abs(e.source.y - e.target.y));

        // Reorder the rows of the left levels to minimise crossings. Hosts never
        // change level, so the left-to-right placement stays as it is.
        const order = columns.map(c => c.slice());
        let bestOrder = order.map(c => c.slice());
        let bestGeo = place(order);
        let bestScore = score(bestGeo);
        let bestSpread = 1.5;
        let bestPinned = null;
        const consider = () => {
            const geo = place(order);
            const s = score(geo);
            if (s < bestScore) {
                bestScore = s;
                bestGeo = geo;
                bestOrder = order.map(c => c.slice());
                return true;
            }
            return false;
        };

        if (layerCount > 1) {
            const sortBy = (col, neighbours) => {
                const geo = place(order);
                const key = new Map(order[col].map(name => {
                    const list = neighbours.get(name);
                    const own = geo.coords.get(name).y;
                    return [name, list.length ? d3.mean(list, n => geo.anchorY.get(n)) : own];
                }));
                order[col].sort((a, b) => key.get(a) - key.get(b));
            };

            // Barycenter sweeps, alternating towards the parents and the children
            for (let round = 0; round < 8; round++) {
                for (let col = 1; col < layerCount; col++) sortBy(col, parentsOf);
                consider();
                for (let col = layerCount - 1; col >= 1; col--) sortBy(col, childrenOf);
                consider();
            }

            // Then try swapping neighbours in each level while that still helps
            // (skipped on very large graphs to keep rendering quick)
            order.forEach((c, i) => order[i] = bestOrder[i].slice());
            if (validLinks.length <= 400) {
                for (let pass = 0, improved = true; improved && pass < 6; pass++) {
                    improved = false;
                    for (let col = 1; col < layerCount; col++) {
                        for (let i = 0; i + 1 < order[col].length; i++) {
                            [order[col][i], order[col][i + 1]] = [order[col][i + 1], order[col][i]];
                            if (consider()) {
                                improved = true;
                            } else {
                                [order[col][i], order[col][i + 1]] = [order[col][i + 1], order[col][i]];
                            }
                        }
                    }
                }
            }
        }

        // Try a few trade-offs for spreading the rightmost groups out
        [0.25, 0.75, 3, 6, 12].forEach(spread => {
            const geo = place(bestOrder, spread);
            const s = score(geo);
            if (s < bestScore) {
                bestScore = s;
                bestGeo = geo;
                bestSpread = spread;
            }
        });

        // Then try moving each rightmost group to any free spot within a few
        // rows of where it is, in any sub-column, keeping each move that lowers
        // the score (skipped on very large graphs)
        if (linkedGroups.length > 1 && validLinks.length <= 400) {
            place(bestOrder, bestSpread);
            const pinned = new Map(linkedGroups.map(group => [group, group.placed]));
            for (let pass = 0, improved = true; improved && pass < 3; pass++) {
                improved = false;
                linkedGroups.forEach(group => {
                    const current = pinned.get(group);
                    const subCount = Math.max(...[...pinned.values()].map(p => p.k)) + 1;
                    let bestMove = null;
                    for (let k = 0; k < Math.max(subCount, subColumnLimit); k++) {
                        for (let start = current.start - 3; start <= current.start + 3; start++) {
                            if (k === current.k && start === current.start) continue;
                            if (start < 0 || start + group.names.length > maxRows) continue;
                            const trial = new Map(pinned).set(group, {k, start});
                            const geo = place(bestOrder, bestSpread, trial);
                            const s = score(geo);
                            if (s < bestScore && (!bestMove || s < bestMove.s)) bestMove = {trial, geo, s};
                        }
                    }
                    if (bestMove) {
                        bestScore = bestMove.s;
                        bestGeo = bestMove.geo;
                        bestPinned = bestMove.trial;
                        improved = true;
                        // A move can push other groups around; record where all of them ended up
                        place(bestOrder, bestSpread, bestMove.trial);
                        linkedGroups.forEach(g => pinned.set(g, g.placed));
                    }
                });
            }
        }

        // Size of a layout, cropped to the rows actually used
        const extent = geo => {
            const ys = [...geo.coords.values()].map(p => p.y);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            return {top: minY - PADDING, height: maxY - minY + 2 * PADDING + 8, rows: maxY - minY};
        };

        // Spread out a little where there is room, so arrows between levels
        // and rows aren't cramped, but keep it compact: the lists of boxes in
        // the rightmost level stay at their normal distance, rows stretch to at
        // most 1.25x and the gaps between levels to at most 1.75x. On a large
        // screen the rest is left as margin around the (centred) diagram
        // rather than pulling the lists apart.
        let geo = bestGeo;
        if (avail && avail.width > 0 && avail.height > 0) {
            const sp = Object.assign({}, BASE);
            const levelGaps = (layerCount - 1) * BASE.columnGap;
            const extraWidth = avail.width - geo.width;
            if (extraWidth > 0 && levelGaps > 0) {
                sp.columnGap = BASE.columnGap * Math.min(1.75, 1 + extraWidth / levelGaps);
            }
            const size = extent(geo);
            const rowSteps = size.rows / BASE.rowHeight;
            const extraHeight = avail.height - size.height;
            if (extraHeight > 0 && rowSteps >= 1) {
                sp.rowHeight = Math.min(1.25 * BASE.rowHeight, BASE.rowHeight + extraHeight / rowSteps);
            }
            geo = place(bestOrder, bestSpread, bestPinned, sp);
        }

        const size = extent(geo);
        return {coords: geo.coords, boxes: geo.boxes, edges: geo.edges, width: geo.width, height: size.height, top: size.top};
    }

    // Label widths as drawn (bold for group members, italic for the rest),
    // with the badge of a synthetic host
    function measureLabels(nodes) {
        const ctx = document.createElement("canvas").getContext("2d");
        return new Map(nodes.map(n => {
            ctx.font = ((n.inGroup !== undefined ? n.inGroup : n.synthetic) ? "bold" : "italic") + " " + FONT_SIZE + "px sans-serif";
            const text = ctx.measureText(n.label).width;
            return [n.name, n.aggregate ? text + BADGE_GAP + badgeWidth(ctx, n.aggregate) : text];
        }));
    }

    // ELK (Eclipse Layout Kernel, elkjs) is large, so it isn't part of the
    // script bundle Icinga Web loads on every page: the module serves it from
    // .../index/elk and it is loaded only when the ELK layout is chosen
    let elkLoading = null;
    function loadElk() {
        if (window.ELK) return Promise.resolve(window.ELK);
        if (!elkLoading) {
            elkLoading = new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = window.location.pathname.replace(/\/+$/, "") + "/index/elk";
                script.onload = () => window.ELK ? resolve(window.ELK) : reject(new Error("ELK did not load"));
                script.onerror = () => {
                    elkLoading = null;
                    reject(new Error("could not load ELK"));
                };
                document.head.appendChild(script);
            });
        }
        return elkLoading;
    }

    /**
     * Lay out the graph with ELK's layered algorithm instead of computeLayout.
     *
     * Parents are on the right (direction LEFT). Hosts without parents are
     * grouped by their exact set of children, as in the standard layout, and
     * each group is one ELK node the size of its box, so a group's arrows leave
     * from a single point; hosts further left with the same parents and
     * children are one ELK node too. Every host has fixed ports: arrows leave from the
     * left end of the label and arrive at the dot. ELK routes the arrows
     * orthogonally around hosts and boxes.
     *
     * options.hybrid: wrap the tallest column of groups into side-by-side
     * sub-columns, like the standard layout does, sized for options.area. A
     * group in sub-column j gets a chain of j invisible stepping stones before
     * its children, which pushes it j columns further out; ELK routes its arrow
     * through them, drawn as one line.
     *
     * Resolves to the same shape as computeLayout: {coords, boxes, edges,
     * width, height, top}; each edge also carries its route in `points`.
     */
    function computeElkLayout(nodes, links, options = {}) {
        return loadElk().then(ELK => {
            const elk = new ELK();
            const ROW = BASE.rowHeight;
            const DOT_PAD = 4; // space right of a dot
            const LAYER_GAP = 60;
            const labelWidth = measureLabels(nodes);
            const names = new Set(nodes.map(n => n.name));
            const validLinks = links.filter(l => names.has(l.source) && names.has(l.target) && l.source !== l.target);
            const childrenOf = new Map(nodes.map(n => [n.name, []]));
            const parentsOf = new Map(nodes.map(n => [n.name, []]));
            const hasParent = new Set();
            validLinks.forEach(l => {
                childrenOf.get(l.source).push(l.target);
                parentsOf.get(l.target).push(l.source);
                hasParent.add(l.target);
            });

            // Hosts without parents, grouped by their children
            const groupByKey = new Map();
            nodes.filter(n => !hasParent.has(n.name)).forEach(n => {
                const key = childrenOf.get(n.name).slice().sort().join("\0");
                if (!groupByKey.has(key)) {
                    groupByKey.set(key, {id: "group:" + groupByKey.size, names: [], children: childrenOf.get(n.name).slice()});
                }
                groupByKey.get(key).names.push(n.name);
            });
            const groups = [...groupByKey.values()];
            const groupOf = new Map();
            const groupById = new Map(groups.map(group => [group.id, group]));
            groups.forEach(group => {
                group.names.sort((a, b) => d3.ascending(a, b));
                group.names.forEach(name => groupOf.set(name, group));
                group.width = BOX_PAD_X + Math.max(...group.names.map(name => labelWidth.get(name))) + LABEL_OFFSET + 5 + BOX_PAD_X;
                group.height = group.names.length * ROW + 4;
            });
            // Hosts further left with the same parents and children: one
            // node the size of their box, arrows in on the right, out on the left
            const siblings = siblingGroups(nodes.map(n => n.name), parentsOf, childrenOf).map((names, i) => ({
                id: "siblings:" + i, names, children: childrenOf.get(names[0]).slice(),
                width: BOX_PAD_X + Math.max(...names.map(name => labelWidth.get(name))) + LABEL_OFFSET + 5 + BOX_PAD_X,
                height: names.length * ROW + 4
            }));
            const siblingOf = new Map();
            siblings.forEach(group => group.names.forEach(name => siblingOf.set(name, group)));
            const unitOf = name => groupOf.has(name) ? groupOf.get(name).id : siblingOf.has(name) ? siblingOf.get(name).id : name;
            const port = (id, side, x, y) => ({id, x, y, width: 0, height: 0, layoutOptions: {"elk.port.side": side}});

            // One arrow per parent and child; the hosts of a box share theirs
            const arrows = new Map();
            validLinks.forEach(l => {
                const from = unitOf(l.source), to = unitOf(l.target);
                const id = from + "->" + to;
                if (!arrows.has(id)) {
                    arrows.set(id, {id, from, to, children: siblingOf.has(l.target) ? siblingOf.get(l.target).names : [l.target]});
                }
            });

            const layoutOptions = {
                "elk.algorithm": "layered",
                "elk.direction": "LEFT",
                "elk.edgeRouting": "ORTHOGONAL",
                "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
                "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYER_GAP),
                "elk.layered.spacing.edgeNodeBetweenLayers": "12",
                "elk.spacing.nodeNode": "8",
                "elk.spacing.edgeNode": "8",
                "elk.spacing.edgeEdge": "6",
                "elk.separateConnectedComponents": "true",
                "elk.spacing.componentComponent": "24",
                "elk.padding": "[top=" + PADDING + ",left=" + PADDING + ",bottom=" + PADDING + ",right=" + PADDING + "]"
            };

            // The ELK graph; chains maps a group id to its number of stepping stones
            const build = chains => {
                const children = [];
                const edges = [];
                groups.forEach(group => {
                    children.push({
                        id: group.id, width: group.width, height: group.height,
                        layoutOptions: {"elk.portConstraints": "FIXED_POS"},
                        ports: [port(group.id + ":out", "WEST", 0, group.height / 2)]
                    });
                    // Stepping stones: tiny nodes the group's arrows run through
                    for (let i = 1; i <= (chains.get(group.id) || 0); i++) {
                        const id = group.id + ":stone" + i;
                        children.push({
                            id, width: 2, height: 2,
                            layoutOptions: {"elk.portConstraints": "FIXED_POS"},
                            ports: [port(id + ":out", "WEST", 0, 1), port(id + ":in", "EAST", 2, 1)]
                        });
                        const previous = i === 1 ? group.id : group.id + ":stone" + (i - 1);
                        edges.push({id: id + ":edge", sources: [previous + ":out"], targets: [id + ":in"]});
                    }
                });
                siblings.forEach(group => children.push({
                    id: group.id, width: group.width, height: group.height,
                    layoutOptions: {"elk.portConstraints": "FIXED_POS"},
                    ports: [port(group.id + ":out", "WEST", 0, group.height / 2),
                        port(group.id + ":in", "EAST", group.width, group.height / 2)]
                }));
                nodes.filter(n => hasParent.has(n.name) && !siblingOf.has(n.name)).forEach(n => {
                    const width = labelWidth.get(n.name) + LABEL_OFFSET + 5 + DOT_PAD;
                    children.push({
                        id: n.name, width, height: ROW,
                        layoutOptions: {"elk.portConstraints": "FIXED_POS"},
                        ports: [port(n.name + ":out", "WEST", 0, ROW / 2), port(n.name + ":in", "EAST", width, ROW / 2)]
                    });
                });
                arrows.forEach(a => {
                    const stones = groupById.has(a.from) ? (chains.get(a.from) || 0) : 0;
                    const start = stones ? a.from + ":stone" + stones : a.from;
                    edges.push({id: a.id, sources: [start + ":out"], targets: [a.to + ":in"]});
                });
                return {id: "root", layoutOptions, children, edges};
            };

            // Turn ELK's result into what render() draws
            const interpret = (result, chains) => {
                const placed = new Map(result.children.map(c => [c.id, c]));
                const routed = new Map((result.edges || []).map(e => [e.id, e]));
                const sectionPoints = id => {
                    const section = ((routed.get(id) || {}).sections || [])[0];
                    return section ? [section.startPoint, ...(section.bendPoints || []), section.endPoint] : [];
                };
                const coords = new Map();
                const boxes = [];
                groups.forEach(group => {
                    const box = placed.get(group.id);
                    const dotX = box.x + box.width - BOX_PAD_X - 5;
                    group.names.forEach((name, i) => coords.set(name, {x: dotX, y: box.y + 2 + ROW / 2 + i * ROW}));
                    boxes.push({
                        names: group.names, children: group.children,
                        x0: box.x, x1: box.x + box.width, y0: box.y, y1: box.y + box.height
                    });
                });
                const siblingBoxes = new Map();
                siblings.forEach(group => {
                    const box = placed.get(group.id);
                    const dotX = box.x + box.width - BOX_PAD_X - 5;
                    group.names.forEach((name, i) => coords.set(name, {x: dotX, y: box.y + 2 + ROW / 2 + i * ROW}));
                    const drawnBox = {
                        names: group.names, children: group.children, sibling: true,
                        x0: box.x, x1: box.x + box.width, y0: box.y, y1: box.y + box.height
                    };
                    boxes.push(drawnBox);
                    siblingBoxes.set(group.id, drawnBox);
                });
                nodes.filter(n => hasParent.has(n.name) && !siblingOf.has(n.name)).forEach(n => {
                    const box = placed.get(n.name);
                    coords.set(n.name, {x: box.x + labelWidth.get(n.name) + LABEL_OFFSET, y: box.y + ROW / 2});
                });

                const edges = [...arrows.values()].map(a => {
                    // Into a box: its right edge (the port); else the dot
                    const box = siblingBoxes.get(a.to);
                    const end = box ? {x: box.x1, y: (box.y0 + box.y1) / 2} : coords.get(a.to);
                    const points = [];
                    // Through the stepping stones first, if any
                    const stones = groupById.has(a.from) ? (chains.get(a.from) || 0) : 0;
                    for (let i = 1; i <= stones; i++) points.push(...sectionPoints(a.from + ":stone" + i + ":edge"));
                    points.push(...sectionPoints(a.id));
                    if (!points.length) points.push({x: end.x + 30, y: end.y});
                    // Finish at the dot (the port sits just right of it)
                    if (!box) points.push({x: end.x, y: end.y});
                    const from = groupById.get(a.from) || siblings.find(g => g.id === a.from);
                    return {
                        source: points[0],
                        target: end,
                        child: a.children[0],
                        children: a.children,
                        // A box's arrow belongs to all of its hosts
                        parents: from ? from.names : [a.from],
                        points
                    };
                });

                return {coords, boxes, edges, width: result.width, height: result.height, top: 0};
            };

            const none = new Map();
            return elk.layout(build(none)).then(first => {
                if (!options.hybrid || !options.area) return interpret(first, none);
                const chains = chooseWrapping(first, groups, options.area, LAYER_GAP);
                if (!chains.size) return interpret(first, none);
                return elk.layout(build(chains)).then(second => interpret(second, chains));
            });
        });
    }

    /**
     * For the hybrid layout: given a first ELK run, decide how to wrap the
     * rightmost column of groups (those with children) into k side-by-side
     * sub-columns, and return the stepping stones each group needs (0 for the
     * first sub-column). k is chosen like the standard layout chooses its
     * sub-column height: show the diagram as large as possible up to 100%, and
     * among sizes that fit, the one shaped most like the viewport. Groups are
     * dealt out in turn from top to bottom, so every sub-column covers the
     * whole height and groups stay level with their children.
     */
    function chooseWrapping(first, groups, area, layerGap) {
        const placed = new Map(first.children.map(c => [c.id, c]));
        const linked = groups.filter(g => g.children.length).map(g => ({group: g, box: placed.get(g.id)}));
        if (linked.length < 2) return new Map();
        const right = Math.max(...linked.map(g => g.box.x + g.box.width));
        const column = linked.filter(g => g.box.x + g.box.width > right - 1).sort((a, b) => a.box.y - b.box.y);
        if (column.length < 2) return new Map();

        const inColumn = new Set(column.map(g => g.group.id));
        const others = first.children.filter(c => !inColumn.has(c.id));
        const span = list => list.length
            ? Math.max(...list.map(c => c.y + c.height)) - Math.min(...list.map(c => c.y))
            : 0;
        const columnHeight = span(column.map(g => g.box));
        const otherHeight = span(others);
        const columnWidth = Math.max(...column.map(g => g.box.width));
        const padding = 2 * PADDING;
        const targetAspect = area.width / area.height;

        let best = {k: 1, scale: -1, aspectError: Infinity};
        for (let k = 1; k <= Math.min(8, column.length); k++) {
            const width = first.width + (k - 1) * (columnWidth + layerGap);
            const height = Math.max(otherHeight, columnHeight / k) + padding;
            const scale = Math.min(1, area.width / width, area.height / height);
            const aspectError = Math.abs(Math.log((width / height) / targetAspect));
            if (scale > best.scale + 1e-6 || (Math.abs(scale - best.scale) <= 1e-6 && aspectError < best.aspectError)) {
                best = {k, scale, aspectError};
            }
        }

        const chains = new Map();
        if (best.k > 1) column.forEach((g, i) => { if (i % best.k) chains.set(g.group.id, i % best.k); });
        return chains;
    }

    // An orthogonal route as an SVG path with rounded corners
    function roundedPath(points, radius = 6) {
        let d = "M" + points[0].x + "," + points[0].y;
        for (let i = 1; i < points.length - 1; i++) {
            const prev = points[i - 1], at = points[i], next = points[i + 1];
            const inLength = Math.hypot(at.x - prev.x, at.y - prev.y);
            const outLength = Math.hypot(next.x - at.x, next.y - at.y);
            const r = Math.min(radius, inLength / 2, outLength / 2);
            if (r < 0.5) {
                d += "L" + at.x + "," + at.y;
                continue;
            }
            const before = {x: at.x - (at.x - prev.x) / inLength * r, y: at.y - (at.y - prev.y) / inLength * r};
            const after = {x: at.x + (next.x - at.x) / outLength * r, y: at.y + (next.y - at.y) / outLength * r};
            d += "L" + before.x + "," + before.y + "Q" + at.x + "," + at.y + " " + after.x + "," + after.y;
        }
        const last = points[points.length - 1];
        return d + "L" + last.x + "," + last.y;
    }

    /**
     * Hosts without children, for the subset picker, sorted by label.
     */
    function hostsWithoutChildren(data) {
        const nodes = data.nodes || [];
        const names = new Set(nodes.map(n => n.name));
        const hasChildren = new Set((data.links || [])
            .filter(l => names.has(l.source) && names.has(l.target))
            .map(l => l.source));
        return nodes
            .filter(n => !hasChildren.has(n.name))
            .sort((a, b) => d3.ascending(a.label, b.label));
    }

    /**
     * The graph with synthetic hosts' members folded into them: a member is
     * left out when its only children are synthetic hosts it is a member of,
     * and those hosts take over its parents (and so on, for members of
     * members). Members with other children stay, so no dependency is lost.
     * Returns the new data and, per synthetic host, the members left out.
     */
    function collapseMembers(data) {
        const nodes = data.nodes || [], links = data.links || [];
        const byName = new Map(nodes.map(n => [n.name, n]));
        const parentsOf = new Map(nodes.map(n => [n.name, []]));
        const childrenOf = new Map(nodes.map(n => [n.name, []]));
        links.forEach(l => {
            if (!byName.has(l.source) || !byName.has(l.target)) return;
            parentsOf.get(l.target).push(l.source);
            childrenOf.get(l.source).push(l.target);
        });
        const memberOf = (member, host) => {
            const aggregate = (byName.get(host) || {}).aggregate;
            return !!aggregate && aggregate.members.includes(member);
        };
        const hidden = new Set(nodes
            .filter(n => childrenOf.get(n.name).length && childrenOf.get(n.name).every(c => memberOf(n.name, c)))
            .map(n => n.name));
        if (!hidden.size) return {data, folded: new Map()};

        // The visible hosts a host's parents stand for
        const visibleParents = (name, seen = new Set()) => {
            const result = [];
            parentsOf.get(name).forEach(parent => {
                if (seen.has(parent)) return;
                seen.add(parent);
                if (hidden.has(parent)) result.push(...visibleParents(parent, seen));
                else result.push(parent);
            });
            return result;
        };
        const folded = new Map();
        const newLinks = [];
        nodes.filter(n => !hidden.has(n.name)).forEach(n => {
            const members = parentsOf.get(n.name).filter(p => hidden.has(p));
            if (members.length) folded.set(n.name, members);
            [...new Set(visibleParents(n.name))]
                .filter(parent => parent !== n.name)
                .forEach(parent => newLinks.push({source: parent, target: n.name}));
        });
        return {
            data: Object.assign({}, data, {nodes: nodes.filter(n => !hidden.has(n.name)), links: newLinks}),
            folded
        };
    }

    /**
     * The part of the graph above some hosts: those hosts, their parents,
     * their parents' parents and so on, with the dependencies between them.
     */
    function subsetAbove(data, names) {
        const parentsOf = new Map();
        (data.links || []).forEach(l => {
            if (!parentsOf.has(l.target)) parentsOf.set(l.target, []);
            parentsOf.get(l.target).push(l.source);
        });
        const keep = new Set(names);
        const queue = [...names];
        while (queue.length) {
            (parentsOf.get(queue.shift()) || []).forEach(parent => {
                if (!keep.has(parent)) {
                    keep.add(parent);
                    queue.push(parent);
                }
            });
        }
        return {
            nodes: (data.nodes || []).filter(n => keep.has(n.name)),
            links: (data.links || []).filter(l => keep.has(l.source) && keep.has(l.target))
        };
    }

    // What is shown lives in the page URL, so it can be bookmarked or shared:
    // ?host=a&host=b and/or ?hostgroup=g for a subset, ?services=notified to
    // leave out services with notifications disabled, ?layout=elk|hybrid
    const readUrlState = () => {
        const params = new URLSearchParams(window.location.search);
        return {
            hosts: params.getAll("host"),
            hostgroups: params.getAll("hostgroup"),
            notifiedOnly: params.get("services") === "notified",
            collapsed: params.get("members") === "collapsed",
            layout: ["elk", "hybrid"].includes(params.get("layout")) ? params.get("layout") : "standard"
        };
    };
    const writeUrlState = (state, container) => {
        const url = new URL(window.location.href);
        // Always written in the same order: hosts, host groups, then options
        url.searchParams.delete("host");
        url.searchParams.delete("hostgroup");
        url.searchParams.delete("services");
        url.searchParams.delete("members");
        url.searchParams.delete("layout");
        state.hosts.forEach(name => url.searchParams.append("host", name));
        (state.hostgroups || []).forEach(name => url.searchParams.append("hostgroup", name));
        if (state.notifiedOnly) url.searchParams.append("services", "notified");
        if (state.collapsed) url.searchParams.append("members", "collapsed");
        if (state.layout && state.layout !== "standard") url.searchParams.append("layout", state.layout);
        if (url.href !== window.location.href) {
            // Replace rather than push: Icinga keeps its own history entries,
            // and its state object is kept as it is
            window.history.replaceState(window.history.state, "", url.href);
        }
        // Icinga reloads a column from its data-icinga-url; keep that in step
        const column = container.closest("[data-icinga-url]");
        if (column && column.getAttribute("data-icinga-url") !== url.pathname + url.search) {
            column.setAttribute("data-icinga-url", url.pathname + url.search);
        }
    };

    Topologygraph.prototype = {

        initialize: function () {
            this.module.on('rendered', this.onRenderedContainer);
        },

        onRenderedContainer: function (event) {
            const container = document.getElementById('topologygraph-container');
            // in module configuration we don't have a graph, so return peacefully
            if (!container) {
                return;
            }

            // The host groups to graph (none: the default from the settings).
            // An answer for groups no longer chosen is dropped.
            let hostGroups = readUrlState().hostgroups;
            const STALE = {};
            const load = () => {
                const asked = hostGroups.join("\n");
                const params = new URLSearchParams();
                hostGroups.forEach(name => params.append("hostgroup", name));
                const query = params.toString();
                return fetch(window.location.pathname + "/index/data" + (query ? "?" + query : ""),
                    {cache: "no-store", headers: {Accept: "application/json"}})
                    .then(response => {
                        if (!response.ok) throw new Error("HTTP " + response.status);
                        return response.json();
                    })
                    .then(data => {
                        if (hostGroups.join("\n") !== asked) throw STALE;
                        return data;
                    });
            };
            const time = () => new Date().toLocaleTimeString();

            // Only one refresh loop at a time, even if Icinga renders us again
            if (this.stopRefresh) this.stopRefresh();

            // Build the (empty) viewport straight away, so there is something
            // to see while Icinga is asked for the data
            // Other host groups chosen on the page: load their graph
            const changeHostGroups = groups => {
                hostGroups = groups;
                graph.progress("Loading hosts from Icinga\u2026", 0.15);
                load().then(data => {
                    if (!graph.isConnected()) return;
                    graph.setData(data, true);
                    graph.setStatus("Updated " + time());
                }).catch(error => {
                    if (error !== STALE && graph.isConnected()) {
                        graph.progressFailed("Could not load the host groups (" + error.message + ")");
                    }
                });
            };
            const graph = this.mount(container, {onHostGroups: changeHostGroups});
            graph.progress("Loading hosts from Icinga\u2026", 0.15);

            load().then(data => {
                if (!graph.isConnected()) return;
                graph.progress("Received " + (data.nodes || []).length + " hosts\u2026", 0.4);
                graph.setData(data);
                graph.setStatus("Updated " + time());

                let busy = false;
                let timer = null;
                const stop = () => {
                    clearInterval(timer);
                    document.removeEventListener("visibilitychange", onVisible);
                    if (this.stopRefresh === stop) this.stopRefresh = null;
                };
                const refresh = () => {
                    if (!graph.isConnected()) {
                        stop(); // navigated away
                        return;
                    }
                    if (document.hidden || busy) return;
                    busy = true;
                    load().then(fresh => {
                        if (!graph.isConnected()) return;
                        graph.setData(fresh);
                        graph.setStatus("Updated " + time());
                        // Follow a changed refresh interval setting
                        if (refreshInterval(fresh) !== interval) {
                            interval = refreshInterval(fresh);
                            clearInterval(timer);
                            timer = setInterval(refresh, interval);
                        }
                    }).catch(error => {
                        if (error !== STALE && graph.isConnected()) graph.setStatus("Update failed, retrying");
                    }).finally(() => { busy = false; });
                };
                // Catch up straight away when the tab becomes visible again
                const onVisible = () => { if (!document.hidden) refresh(); };
                document.addEventListener("visibilitychange", onVisible);
                let interval = refreshInterval(data);
                timer = setInterval(refresh, interval);
                this.stopRefresh = stop;
            }).catch(error => {
                if (graph.isConnected()) {
                    // (no STALE here: nothing can be chosen before the first answer)
                    graph.progressFailed("Could not load the graph (" + error.message + "). Reload the page to try again.");
                }
            });
        },

        /**
         * Build the zoomable viewport in container and return an API to feed it
         * data: {setData(data), setStatus(text), isConnected()}.
         *
         * The viewport fills the browser window below its top edge, reaching
         * into the surrounding padding so there is no border around it. The
         * graph is laid out to match the viewport's shape and re-laid out when
         * the viewport changes size (unless the user has zoomed or panned),
         * when entering or leaving full screen, and when the shown subset or
         * the hosts and dependencies change. State-only changes recolour the
         * drawing in place.
         *
         * Controls: a picker to show only one bottom-level host and everything
         * above it, zoom in/out, fit, 100% and full screen. Scroll (or pinch) to
         * zoom around the pointer, drag to move; Shift + scroll also moves the
         * diagram.
         */
        mount: function (container, options = {}) {
            const navigation = document.getElementById("navigation");
            const textColor = (navigation && rgbToHex(getComputedStyle(navigation).getPropertyValue('color').trim())) || "#535353";

            // Labels get an outline in the page background colour so arrows
            // passing behind them don't hide the text
            let background = null;
            for (let el = container; el; el = el.parentElement) {
                const bg = getComputedStyle(el).backgroundColor;
                if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) {
                    background = bg;
                    break;
                }
            }


            const viewport = document.createElement("div");
            viewport.className = "topologygraph-viewport";
            if (background) viewport.style.backgroundColor = background;

            const svg = d3.select(viewport).append("svg")
                .attr("width", "100%")
                .attr("height", "100%")
                .attr("style", "display: block; touch-action: none; font: " + FONT_SIZE + "px sans-serif;");
            const defs = svg.append("defs");
            // One arrowhead per arrow colour
            const arrowColours = [COLOURS.edge, COLOURS.down, COLOURS.unreachable, COLOURS.edgeOutside];
            const markerFor = colour => "url(#topologygraph-arrow-" + arrowColours.indexOf(colour) + ")";
            // A hollow diamond where a synthetic host's members meet it
            const diamondColours = [COLOURS.edge, COLOURS.edgeOutside, COLOURS.warning, COLOURS.down];
            const diamondFor = colour => "url(#topologygraph-diamond-" + Math.max(0, diamondColours.indexOf(colour)) + ")";
            diamondColours.forEach((colour, i) => {
                const diamond = defs.append("marker")
                    .attr("id", "topologygraph-diamond-" + i)
                    .attr("viewBox", "0 -4 12 8")
                    .attr("markerUnits", "userSpaceOnUse")
                    .attr("markerWidth", 12)
                    .attr("markerHeight", 8)
                    // Just clear of the dot and its service ring
                    .attr("refX", -9)
                    .attr("refY", 0)
                    .attr("orient", "auto");
                diamond.append("path")
                    .attr("d", "M0.6,0L6,-3.4L11.4,0L6,3.4Z")
                    .attr("fill", background || "#fff")
                    .attr("stroke", colour)
                    .attr("stroke-width", 1.2);
            });
            arrowColours.forEach((colour, i) => {
                const id = "topologygraph-arrow-" + i;
                defs.append("marker")
                    .attr("id", id)
                    .attr("viewBox", "0 -5 10 10")
                    // The tip touches the end of the parent's label or its box
                    .attr("refX", 10)
                    .attr("refY", 0)
                    .attr("markerWidth", 6)
                    .attr("markerHeight", 6)
                    .attr("orient", "auto")
                    .append("path")
                    .attr("d", "M0,-5L10,0L0,5")
                    .attr("fill", colour);
            });
            // zoomLayer carries the zoom/pan transform; content shifts the drawing
            // so its cropped top edge sits at y = 0
            const zoomLayer = svg.append("g");
            const content = zoomLayer.append("g");

            // Loading progress: a card in the middle until there is a drawing,
            // then a slim bar at the top while the graph is laid out again.
            // The moving highlight is a CSS transform animation, which the
            // browser keeps running even while the layout calculation is busy.
            const loading = document.createElement("div");
            loading.className = "topologygraph-loading";
            loading.hidden = true;
            loading.setAttribute("role", "status");
            const loadingText = document.createElement("div");
            loadingText.className = "topologygraph-loading-text";
            const loadingBar = document.createElement("div");
            loadingBar.className = "topologygraph-loading-bar";
            const loadingFill = document.createElement("div");
            loadingFill.className = "topologygraph-loading-fill";
            loadingBar.append(loadingFill);
            loading.append(loadingText, loadingBar);
            viewport.append(loading);
            const progress = (text, fraction) => {
                loading.hidden = false;
                loading.classList.toggle("topologygraph-loading-first", previous === null);
                loading.classList.remove("topologygraph-loading-failed");
                loadingText.textContent = text;
                loadingFill.style.width = Math.round(Math.max(0.05, Math.min(1, fraction)) * 100) + "%";
            };
            const progressDone = () => { loading.hidden = true; };
            const progressFailed = text => {
                progress(text, 1);
                loading.classList.add("topologygraph-loading-failed");
            };
            // Resolves after the browser has had a chance to paint
            const afterPaint = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

            const emptyMessage = document.createElement("p");
            emptyMessage.className = "topologygraph-empty";
            emptyMessage.hidden = true;
            viewport.append(emptyMessage);

            // Size of the current drawing, and whether the user has taken over the view
            let width = 1, height = 1;
            let userMoved = false;

            const zoom = d3.zoom()
                .scaleExtent([0.1, 4])
                // The wheel zooms around the pointer; with Shift held it moves the
                // diagram instead (see wheel.pan below)
                .filter(event => event.type === "wheel" ? !event.shiftKey : !event.button)
                // Gentle steps for a mouse wheel; trackpad pinches send small
                // deltas, so those get boosted to feel natural
                .wheelDelta(event => {
                    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode ? 100 : 1);
                    return -delta * 0.002 * (Math.abs(delta) < 40 ? 5 : 1);
                })
                .on("zoom", event => {
                    zoomLayer.attr("transform", event.transform);
                    if (event.sourceEvent) userMoved = true;
                });
            svg.call(zoom).on("dblclick.zoom", null);

            // Shift + scroll moves the diagram. Some browsers turn Shift + wheel
            // into a sideways scroll (deltaX), so take whichever is set and move
            // vertically for deltaY and sideways for deltaX.
            svg.on("wheel.pan", event => {
                if (!event.shiftKey) return;
                const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
                const dx = event.deltaX * unit;
                const dy = event.deltaY * unit;
                const before = d3.zoomTransform(svg.node());
                zoom.translateBy(svg, -dx / before.k, -dy / before.k);
                const after = d3.zoomTransform(svg.node());
                // Only keep the scroll if the diagram actually moved; at its edges
                // the page scrolls instead
                if (Math.abs(after.x - before.x) > 0.5 || Math.abs(after.y - before.y) > 0.5) {
                    userMoved = true;
                    event.preventDefault();
                }
            }, {passive: false});

            // Bands kept clear for the controls (top) and the hint (bottom), so
            // the fitted diagram never sits underneath them
            const reservedTop = 34, reservedBottom = 18;
            const drawingArea = () => ({
                width: viewport.clientWidth,
                height: Math.max(0, viewport.clientHeight - reservedTop - reservedBottom)
            });

            const fit = animate => {
                const area = drawingArea();
                if (!area.width || !area.height) return;
                const k = Math.min(area.width / width, area.height / height, 1);
                const t = d3.zoomIdentity
                    .translate((area.width - width * k) / 2, reservedTop + (area.height - height * k) / 2)
                    .scale(k);
                // animate: true for the Fit button, or a duration in ms
                const duration = typeof animate === "number" ? animate : 250;
                (animate ? svg.transition().duration(duration).ease(d3.easeCubicInOut) : svg).call(zoom.transform, t);
                userMoved = false;
            };

            // --- Data, subset and drawing ---------------------------------------

            let fullData = {nodes: [], links: []};
            let graphedGroups = []; // the host groups in the data, as the server chose them
            let offeredGroups = []; // [{name, label}] that can be chosen
            let ignoredGroups = []; // asked for, but not offered
            const urlState = readUrlState();
            let selected = urlState.hosts; // ticked host names
            let selectedGroups = urlState.hostgroups; // chosen host groups (none: the default)
            const selectionNames = () => selected;
            let notifiedOnly = urlState.notifiedOnly; // ignore services with notifications disabled
            let collapsed = urlState.collapsed; // synthetic hosts' members folded into them
            let folded = new Map(); // synthetic host -> members left out, when collapsed
            let layout = urlState.layout; // "standard", "elk" or "hybrid"
            const updateUrl = () => writeUrlState({hosts: selected, hostgroups: selectedGroups, notifiedOnly, collapsed, layout}, container);
            // The service summary to show: all services, or only those with
            // notifications enabled (falls back if the server doesn't send it)
            const serviceSummary = d => notifiedOnly && d.services_notified !== undefined ? d.services_notified : d.services;
            let drawn = null; // {structure, update(data)} for what is on screen
            let laidOutFor = {width: 0, height: 0};

            // Nothing ticked: everything; otherwise the ticked hosts and
            // everything above them
            const visibleData = () => {
                const names = selectionNames();
                let base = fullData;
                folded = new Map();
                if (collapsed) ({data: base, folded} = collapseMembers(fullData));
                const shown = names.filter(name => base.nodes.some(n => n.name === name));
                return shown.length ? subsetAbove(base, shown) : base;
            };

            // Re-layouts animate from the previous positions (unless the
            // viewer asked their system for reduced motion)
            const ANIMATE_MS = 450;
            const reducedMotion = () => !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            let previous = null; // {coords, top} of the drawing on screen
            const smoothLink = d3.linkHorizontal().x(p => p.x).y(p => p.y);
            let drawToken = 0;   // a newer draw() supersedes one still waiting for ELK

            let hasData = false; // nothing to lay out until the first data arrives

            const draw = view => {
                if (!hasData) return;
                const token = ++drawToken;
                const data = visibleData();
                // Drawn as a member (bold, solid dot, blue arrows): hosts in the
                // graphed host groups (older servers called this "synthetic")
                const nodes = (data.nodes || []).map(n => Object.assign({}, n, {
                    inGroup: !!(n.member !== undefined ? n.member : n.synthetic)
                }));
                const links = data.links || [];
                emptyMessage.hidden = nodes.length > 0;
                emptyMessage.textContent = graphedGroups.length > 1
                    ? `No hosts found in the host groups ${graphedGroups.join(", ")}.`
                    : `No hosts found in the "${graphedGroups[0] || ""}" host group.`;
                laidOutFor = {width: viewport.clientWidth, height: viewport.clientHeight};
                const area = drawingArea();
                if (!nodes.length) {
                    content.selectAll("*").remove();
                    previous = null;
                    progressDone();
                    drawn = {structure: structureOf(data), update: () => {}, restyle: () => {}};
                    return;
                }

                const standard = () => computeLayout(nodes, links, area);
                const current = () => token === drawToken && viewport.isConnected;
                const laying = `Laying out ${nodes.length} host${nodes.length === 1 ? "" : "s"}\u2026`;
                // The current drawing stays until the new layout is ready. Show
                // progress first and let the browser paint it, because the
                // layout calculation keeps the page busy.
                if (layout === "elk" || layout === "hybrid") {
                    progress(window.ELK ? laying : "Loading the ELK layout engine\u2026", window.ELK ? 0.6 : 0.4);
                    afterPaint()
                        .then(() => loadElk())
                        .then(() => {
                            if (!current()) return null;
                            progress(laying, 0.7);
                            return afterPaint().then(() => computeElkLayout(nodes, links, {hybrid: layout === "hybrid", area}));
                        })
                        .then(geo => {
                            if (!geo || !current()) return;
                            layoutNote.textContent = "";
                            render(geo, nodes, links, data, view);
                        })
                        .catch(error => {
                            if (!current()) return;
                            layoutNote.textContent = "ELK layout failed (" + error.message + "), using the standard layout \u00b7 ";
                            render(standard(), nodes, links, data, view);
                        });
                } else {
                    progress(laying, 0.6);
                    afterPaint().then(() => {
                        if (!current()) return;
                        layoutNote.textContent = "";
                        render(standard(), nodes, links, data, view);
                    });
                }
            };

            const render = (geo, nodes, links, data, view) => {
                const animate = previous !== null && !reducedMotion();
                const before = previous;
                content.selectAll("*").remove();
                width = geo.width;
                height = geo.height;
                content.attr("transform", `translate(0,${-geo.top})`);
                const margin = 40;
                zoom.translateExtent([[-margin, -margin], [width + margin, height + margin]]);

                const nodeByName = new Map(nodes.map(n => [n.name, n]));
                // Arrows take the colour of a child that is down or unreachable;
                // handled problems are faded
                // An arrow into a box is for all of its hosts: the worst of them
                // decides its colour
                const childrenOfEdge = e => (e.children || [e.child]).map(name => nodeByName.get(name)).filter(Boolean);
                const childOf = e => {
                    const children = childrenOfEdge(e);
                    return children.find(c => isProblem(c) && !isHandled(c)) || children.find(c => isProblem(c)) || children[0];
                };
                // Two kinds of arrows: between hosts of the group (blue), and
                // dependencies with a host outside the group at either end
                // (gray). Arrows into a host that is down or unreachable keep
                // that colour either way.
                const outside = e => childrenOfEdge(e).some(c => !c.inGroup)
                    || e.parents.some(p => nodeByName.has(p) && !nodeByName.get(p).inGroup);
                // A synthetic host's members meeting it: membership, not
                // dependency. Coloured by whether the aggregate holds, not by
                // the host's own state.
                const aggregateOf = e => {
                    if ((e.children || [e.child]).length !== 1) return null;
                    const aggregate = (childOf(e) || {}).aggregate;
                    return aggregate && e.parents.every(p => aggregate.members.includes(p)) ? aggregate : null;
                };
                const normalColour = e => outside(e) ? COLOURS.edgeOutside : COLOURS.edge;
                const arrowColour = e => {
                    const aggregate = aggregateOf(e);
                    if (aggregate) {
                        const health = aggregateHealth(aggregate);
                        return health === "failed" ? COLOURS.down : health === "degraded" ? COLOURS.warning : normalColour(e);
                    }
                    return isProblem(childOf(e)) ? stateColor(childOf(e)) : normalColour(e);
                };
                const arrowOpacity = e => {
                    const aggregate = aggregateOf(e);
                    if (aggregate) return aggregateHealth(aggregate) === "ok" ? 0.5 : 0.85;
                    return !isProblem(childOf(e)) ? 0.5 : isHandled(childOf(e)) ? 0.35 : 0.85;
                };
                const arrowRank = e => {
                    const aggregate = aggregateOf(e);
                    if (aggregate) return {ok: 0, degraded: 1, failed: 2}[aggregateHealth(aggregate)];
                    return !isProblem(childOf(e)) ? 0 : isHandled(childOf(e)) ? 1 : 2;
                };

                // Boxes stay unfilled so an edge from an outer box can be followed
                // across inner ones back to where it starts
                const boxRects = content.append("g")
                    .attr("fill", "none")
                    .attr("stroke", textColor)
                    .attr("stroke-opacity", 0.45)
                    .attr("stroke-width", 1.2)
                    .selectAll("rect")
                    .data(geo.boxes)
                    .join("rect")
                    .attr("class", "topologygraph-box")
                    .attr("x", b => b.x0)
                    .attr("y", b => b.y0)
                    .attr("width", b => b.x1 - b.x0)
                    .attr("height", b => b.y1 - b.y0)
                    .attr("rx", 7)
                    .attr("ry", 7);

                const edgePaths = content.append("g")
                    .attr("fill", "none")
                    .attr("stroke-width", 1.6)
                    .selectAll("path")
                    .data(geo.edges)
                    .join("path")
                    // Membership lines: thinner and dotted, a diamond at the
                    // synthetic host instead of an arrowhead
                    .classed("topologygraph-aggregate", e => !!aggregateOf(e))
                    .attr("stroke-width", e => aggregateOf(e) ? 1.4 : null)
                    .attr("stroke-dasharray", e => aggregateOf(e) ? "1.5,3" : null)
                    .attr("stroke-linecap", e => aggregateOf(e) ? "round" : null);
                // The legend explains membership lines while any are drawn
                memberLegend.hidden = !geo.edges.some(e => aggregateOf(e));
                edgePaths
                    // ELK routes arrows around hosts (points); the standard
                    // layout draws a smooth curve between the two ends
                    // Drawn from the child to the parent, so the arrowhead
                    // points at the parent (the layout keeps edges parent first)
                    .attr("d", e => e.points ? roundedPath(e.points.slice().reverse()) : smoothLink({source: e.target, target: e.source}));

                const node = content.append("g")
                    .selectAll("a")
                    .data(nodes)
                    .join("a")
                    .attr("href", d => d.link)
                    .attr("transform", d => {
                        // When animating, start where the host was before
                        const old = animate && before.coords.get(d.name);
                        const p = old ? {x: old.x, y: old.y - before.top + geo.top} : geo.coords.get(d.name);
                        return `translate(${p.x},${p.y})`;
                    });

                const titles = node.append("title");

                // A ring around the dot for the worst service problem: solid for
                // unhandled problems, dashed and faded if all are handled
                const rings = node.append("circle")
                    .attr("r", 8.5)
                    .attr("fill", "none")
                    .attr("stroke-width", 2);

                const circles = node.append("circle")
                    .attr("r", 5)
                    .attr("stroke", d => d.inGroup ? "none" : textColor)
                    .attr("stroke-dasharray", "2,2");

                // A plate in the page background behind each name, so arrows
                // passing behind it don't hide the text. (An outline stroke on
                // the text itself would also be painted over the browser's
                // find-in-page and selection highlights, and smear them.)
                const plates = node.append("rect")
                    .attr("class", "topologygraph-label-plate")
                    .attr("fill", background || "none")
                    .attr("rx", 2);

                const labels = node.append("text")
                    .attr("x", -LABEL_OFFSET)
                    .attr("dy", "0.32em")
                    .attr("text-anchor", "end")
                    .attr("font-weight", d => d.inGroup ? "bold" : "normal")
                    .attr("font-style", d => d.inGroup ? "normal" : "italic")
                    .text(d => d.label);

                // Size each plate to its name as drawn
                const labelLeft = new Map();
                labels.each(function (d) {
                    const box = this.getBBox();
                    labelLeft.set(d.name, box.x);
                    d3.select(this.parentNode).select("rect.topologygraph-label-plate")
                        .attr("x", box.x - 2)
                        .attr("y", box.y + 1)
                        .attr("width", box.width + 4)
                        .attr("height", Math.max(0, box.height - 2));
                });

                // Badge left of a synthetic host's name: members needed of all,
                // and how many are up
                const badges = node.filter(d => !!d.aggregate).append("g")
                    .attr("class", "topologygraph-badge");
                badges.append("rect")
                    .attr("rx", 7)
                    .attr("fill", background || "none")
                    .attr("stroke-width", 1);
                badges.append("text")
                    .attr("dy", "0.32em")
                    .attr("text-anchor", "end")
                    .attr("font-size", BADGE_FONT);

                // Everything that depends on host states, so a refresh can
                // recolour the drawing in place without touching the layout
                const applyStates = () => {
                    titles.text(d => [
                        d.name,
                        "state: " + stateName(d)
                            + (d.acknowledged ? ", acknowledged" : "")
                            + (d.in_downtime ? ", in downtime" : ""),
                        stateName(d) === "unreachable" ? "(down because a parent is down)" : null,
                        servicesText(serviceSummary(d), notifiedOnly),
                        d.zone ? "zone: " + d.zone : null,
                        d.aggregate ? d.aggregate.mode + ": needs " + aggregateText(d.aggregate) : null,
                        d.aggregate && d.aggregate.down.length ? "members down: " + d.aggregate.down.join(", ") : null,
                        folded.has(d.name) ? "members collapsed: " + folded.get(d.name).join(", ") : null,
                        d.aggregate && d.aggregate.unknown.length ? "members unknown or pending: " + d.aggregate.unknown.join(", ") : null,
                        d.inGroup ? null : graphedGroups.length > 1
                            ? "not in the host groups " + graphedGroups.join(", ")
                            : "not in the " + graphedGroups[0] + " host group"
                    ].filter(Boolean).join("\n"));
                    const ringState = d => {
                        const summary = serviceSummary(d);
                        return summary && (summary.worst_unhandled || (summary.worst && summary.worst !== "ok" ? summary.worst : null));
                    };
                    const allHandled = d => !!serviceSummary(d) && !serviceSummary(d).worst_unhandled;
                    rings
                        .attr("display", d => ringState(d) ? null : "none")
                        .attr("stroke", d => COLOURS[ringState(d)] || "none")
                        .attr("stroke-dasharray", d => allHandled(d) ? "2,2" : null)
                        .attr("stroke-opacity", d => allHandled(d) ? 0.6 : 1);
                    const badgeColour = d => ({ok: textColor, degraded: COLOURS.warning, failed: COLOURS.down})[aggregateHealth(d.aggregate)];
                    badges.select("text")
                        .attr("x", d => labelLeft.get(d.name) - BADGE_GAP - 4)
                        .attr("fill", badgeColour)
                        .text(d => aggregateText(d.aggregate));
                    badges.each(function (d) {
                        const box = d3.select(this).select("text").node().getBBox();
                        d3.select(this).select("rect")
                            .attr("x", box.x - 4)
                            .attr("y", -7)
                            .attr("width", box.width + 8)
                            .attr("height", 14)
                            .attr("stroke", badgeColour(d))
                            .attr("stroke-opacity", aggregateHealth(d.aggregate) === "ok" ? 0.45 : 1);
                    });
                    circles
                        .attr("fill", d => stateColor(d))
                        .attr("fill-opacity", d => isHandled(d) ? 0.45 : 1);
                    labels
                        .attr("fill", d => d.inGroup ? stateColor(d) : textColor)
                        .attr("opacity", d => (d.inGroup ? 1 : 0.6) * (isHandled(d) ? 0.6 : 1));
                    edgePaths
                        .attr("stroke", arrowColour)
                        .attr("opacity", arrowOpacity)
                        .attr("marker-end", e => aggregateOf(e) ? "none" : markerFor(arrowColour(e)))
                        .attr("marker-start", e => aggregateOf(e) ? diamondFor(arrowColour(e)) : null)
                        // Unhandled problems are drawn last so they stay on top
                        .sort((a, b) => arrowRank(a) - arrowRank(b));
                };
                applyStates();

                // Hovering a host highlights everything above and below it (and
                // the arrows along those chains) and dims the rest
                const parentsOf = new Map(nodes.map(n => [n.name, []]));
                const childrenOf = new Map(nodes.map(n => [n.name, []]));
                links.forEach(l => {
                    if (!parentsOf.has(l.target) || !childrenOf.has(l.source)) return;
                    parentsOf.get(l.target).push(l.source);
                    childrenOf.get(l.source).push(l.target);
                });
                const reach = (start, next) => {
                    const seen = new Set();
                    const queue = [start];
                    while (queue.length) {
                        next.get(queue.shift()).forEach(n => {
                            if (!seen.has(n)) {
                                seen.add(n);
                                queue.push(n);
                            }
                        });
                    }
                    return seen;
                };
                const highlight = name => {
                    const above = reach(name, parentsOf);
                    const below = reach(name, childrenOf);
                    const related = new Set([name, ...above, ...below]);
                    const onChain = e => e.parents.some(p => (e.children || [e.child]).some(c =>
                        (above.has(p) && (c === name || above.has(c)))
                        || ((p === name || below.has(p)) && below.has(c))));
                    node.style("opacity", d => related.has(d.name) ? null : 0.15);
                    boxRects.style("opacity", b => b.names.some(n => related.has(n)) ? null : 0.15);
                    edgePaths.style("opacity", e => onChain(e) ? 1 : 0.06);
                };
                const clearHighlight = () => {
                    node.style("opacity", null);
                    boxRects.style("opacity", null);
                    edgePaths.style("opacity", null);
                };
                node.on("mouseenter.highlight", (event, d) => highlight(d.name))
                    .on("mouseleave.highlight", clearHighlight);

                drawn = {
                    structure: structureOf(data),
                    update: fresh => {
                        (fresh.nodes || []).forEach(n => {
                            const shown = nodeByName.get(n.name);
                            if (!shown) return;
                            shown.state = n.state;
                            shown.last_check = n.last_check;
                            shown.zone = n.zone;
                            shown.reachable = n.reachable;
                            shown.acknowledged = n.acknowledged;
                            shown.in_downtime = n.in_downtime;
                            shown.services = n.services;
                            shown.services_notified = n.services_notified;
                            shown.aggregate = n.aggregate;
                        });
                        applyStates();
                    },
                    // Recolour after the notified-services option changes
                    restyle: applyStates
                };

                // States may have been updated while ELK was working
                drawn.update(fullData);

                if (animate) {
                    const finalPosition = d => {
                        const p = geo.coords.get(d.name);
                        return `translate(${p.x},${p.y})`;
                    };
                    node.filter(d => before.coords.has(d.name))
                        .transition().duration(ANIMATE_MS).ease(d3.easeCubicInOut)
                        .attr("transform", finalPosition);
                    // New hosts fade in as the others glide; boxes and arrows
                    // only appear once everything has arrived, so they never
                    // sit somewhere their hosts haven't reached yet
                    const fadeIn = (selection, delay, duration) => selection
                        .style("opacity", 0)
                        .transition().delay(delay).duration(duration)
                        .style("opacity", 1)
                        .on("end", function () { d3.select(this).style("opacity", null); });
                    fadeIn(node.filter(d => !before.coords.has(d.name)), 0, ANIMATE_MS);
                    fadeIn(d3.select(boxRects.node() && boxRects.node().parentNode), ANIMATE_MS, 200);
                    fadeIn(d3.select(edgePaths.node() && edgePaths.node().parentNode), ANIMATE_MS, 200);
                }
                previous = {coords: geo.coords, top: geo.top};
                progressDone();

                if (view) {
                    svg.call(zoom.transform, view);
                    userMoved = true;
                } else {
                    // Zoom along with the gliding hosts, so the picture moves as one
                    fit(animate ? ANIMATE_MS : false);
                }
            };

            // --- Controls --------------------------------------------------------

            const controls = document.createElement("div");
            controls.className = "topologygraph-controls";

            // Subset picker: tick hosts without children to show only them
            // and everything above them
            const pickerButton = document.createElement("button");
            pickerButton.type = "button";
            pickerButton.textContent = "All hosts \u25be";
            pickerButton.className = "topologygraph-picker-button";
            pickerButton.title = "Show only some hosts and everything above them";
            const panel = document.createElement("div");
            panel.className = "topologygraph-picker";
            panel.hidden = true;
            const filter = document.createElement("input");
            filter.type = "search";
            filter.placeholder = "Filter hosts";
            const showAll = document.createElement("button");
            showAll.type = "button";
            showAll.textContent = "Show all";
            const panelHead = document.createElement("div");
            panelHead.className = "topologygraph-picker-head";
            panelHead.append(filter, showAll);
            const heading = text => {
                const h = document.createElement("div");
                h.className = "topologygraph-picker-heading";
                h.textContent = text;
                return h;
            };
            const hostHeading = heading("Hosts without children");
            const list = document.createElement("div");
            list.className = "topologygraph-picker-list";
            const lists = document.createElement("div");
            lists.className = "topologygraph-picker-lists";
            lists.append(hostHeading, list);
            // The data behind the current view, with why each host is (or
            // isn't) drawn, for comparing with Icinga or other inventories
            const explainLink = document.createElement("a");
            explainLink.className = "topologygraph-picker-explain";
            explainLink.textContent = "Explain this view as JSON";
            explainLink.title = "Which hosts are drawn and why, and which selected hosts are missing";
            explainLink.target = "_blank";
            explainLink.rel = "noopener";
            const updateExplainLink = () => {
                // Hosts from the page address that aren't in the graph are
                // dropped from the selection; those are the ones most worth
                // explaining, so keep them here
                const inList = name => [...list.querySelectorAll("input")].some(box => box.value === name);
                const hosts = new Set(selected.concat(urlState.hosts.filter(name => !inList(name))));
                const params = new URLSearchParams();
                hosts.forEach(name => params.append("host", name));
                graphedGroups.concat(ignoredGroups).forEach(name => params.append("hostgroup", name));
                const query = params.toString();
                explainLink.href = window.location.pathname + "/index/explain" + (query ? "?" + query : "");
            };
            panel.append(panelHead, lists, explainLink);

            const applySelection = () => {
                const parts = [];
                if (selected.length === 1) parts.push((fullData.nodes.find(n => n.name === selected[0]) || {label: selected[0]}).label);
                if (selected.length > 1) parts.push(selected.length + " hosts");
                pickerButton.textContent = (parts.length ? parts.join(", ") : "All hosts") + " \u25be";
                list.querySelectorAll("input").forEach(box => box.checked = selected.includes(box.value));
                updateUrl();
                updateExplainLink();
            };
            const choose = names => {
                selected = names;
                applySelection();
                draw(null);
            };
            const ticked = container => [...container.querySelectorAll("input:checked")].map(box => box.value);
            const checkboxRow = (value, label, filterText) => {
                const row = document.createElement("label");
                const box = document.createElement("input");
                box.type = "checkbox";
                box.value = value;
                row.append(box, " " + label);
                row.dataset.filter = filterText.toLowerCase();
                return row;
            };

            let pickerFor = null;
            const updatePicker = () => {
                const structure = structureOf(fullData);
                if (structure !== pickerFor) {
                    pickerFor = structure;
                    const hosts = hostsWithoutChildren(fullData);
                    list.replaceChildren(...hosts.map(n => checkboxRow(n.name, n.label, n.label + " " + n.name)));
                    pickerButton.hidden = !hosts.length;
                    filterList();
                }
                // Drop selected hosts that are gone (or now have children)
                const hostNames = new Set([...list.querySelectorAll("input")].map(box => box.value));
                selected = selected.filter(name => hostNames.has(name));
                applySelection();
            };
            const filterList = () => {
                const text = filter.value.trim().toLowerCase();
                lists.querySelectorAll("label").forEach(row => row.hidden = !!text && !row.dataset.filter.includes(text));
            };

            list.addEventListener("change", () => choose(ticked(list)));
            filter.addEventListener("input", filterList);
            showAll.addEventListener("click", () => choose([]));
            const closePanel = () => { panel.hidden = true; };
            pickerButton.addEventListener("click", event => {
                event.preventDefault();
                panel.hidden = !panel.hidden;
                if (!panel.hidden) filter.focus();
            });
            // Close when clicking elsewhere or pressing Escape
            const onOutsideClick = event => {
                if (!viewport.isConnected) {
                    document.removeEventListener("mousedown", onOutsideClick, true);
                    return;
                }
                if (!panel.hidden && !panel.contains(event.target) && event.target !== pickerButton) closePanel();
            };
            // Capture phase: the zoom behaviour stops mousedown on the diagram
            // from bubbling up to the document
            document.addEventListener("mousedown", onOutsideClick, true);
            panel.addEventListener("keydown", event => { if (event.key === "Escape") closePanel(); });

            // Host group picker: which host groups to graph, from those the
            // module settings offer. Changing them loads a new graph.
            const groupButton = document.createElement("button");
            groupButton.type = "button";
            groupButton.className = "topologygraph-hostgroup-button";
            groupButton.title = "Host groups to graph: their hosts, with their direct parents and children";
            groupButton.hidden = true;
            const groupPanel = document.createElement("div");
            groupPanel.className = "topologygraph-picker topologygraph-hostgroup-picker";
            groupPanel.hidden = true;
            const groupFilter = document.createElement("input");
            groupFilter.type = "search";
            groupFilter.placeholder = "Filter host groups";
            const groupDefault = document.createElement("button");
            groupDefault.type = "button";
            groupDefault.textContent = "Default";
            const groupHead = document.createElement("div");
            groupHead.className = "topologygraph-picker-head";
            groupHead.append(groupFilter, groupDefault);
            const groupList = document.createElement("div");
            groupList.className = "topologygraph-hostgroup-list";
            const groupLists = document.createElement("div");
            groupLists.className = "topologygraph-picker-lists";
            groupLists.append(heading("Host groups to graph"), groupList);
            groupPanel.append(groupHead, groupLists);

            let defaultGroup = null;
            const showGroups = groups => {
                groupList.querySelectorAll("input").forEach(box => box.checked = groups.includes(box.value));
                const label = name => (offeredGroups.find(g => g.name === name) || {label: name}).label;
                groupButton.textContent = (groups.length > 1 ? groups.length + " host groups" : label(groups[0] || "")) + " \u25be";
            };
            let groupsFor = null;
            const updateGroupPicker = () => {
                const key = JSON.stringify(offeredGroups);
                if (key !== groupsFor) {
                    groupsFor = key;
                    groupList.replaceChildren(...offeredGroups.map(g => checkboxRow(
                        g.name, g.label === g.name ? g.name : g.label + " (" + g.name + ")", g.label + " " + g.name
                    )));
                    filterGroups();
                }
                // Nothing to choose when only the default is offered
                groupButton.hidden = offeredGroups.length < 2;
                showGroups(graphedGroups);
            };
            const filterGroups = () => {
                const text = groupFilter.value.trim().toLowerCase();
                groupList.querySelectorAll("label").forEach(row => row.hidden = !!text && !row.dataset.filter.includes(text));
            };
            // Wait a moment after a tick, so ticking several groups loads once
            let groupTimer = null;
            const chooseGroups = groups => {
                // Only the default chosen: same as choosing nothing
                selectedGroups = groups.length === 1 && groups[0] === defaultGroup ? [] : groups;
                showGroups(groups.length ? groups : [defaultGroup]);
                updateUrl();
                clearTimeout(groupTimer);
                groupTimer = setTimeout(() => {
                    if (options.onHostGroups) options.onHostGroups(selectedGroups);
                }, 400);
            };
            groupList.addEventListener("change", () => chooseGroups(ticked(groupList)));
            groupFilter.addEventListener("input", filterGroups);
            groupDefault.addEventListener("click", () => chooseGroups([]));
            groupButton.addEventListener("click", event => {
                event.preventDefault();
                groupPanel.hidden = !groupPanel.hidden;
                if (!groupPanel.hidden) groupFilter.focus();
            });
            const onOutsideGroupClick = event => {
                if (!viewport.isConnected) {
                    document.removeEventListener("mousedown", onOutsideGroupClick, true);
                    return;
                }
                if (!groupPanel.hidden && !groupPanel.contains(event.target) && event.target !== groupButton) groupPanel.hidden = true;
            };
            document.addEventListener("mousedown", onOutsideGroupClick, true);
            groupPanel.addEventListener("keydown", event => { if (event.key === "Escape") groupPanel.hidden = true; });
            // Option: leave out services with notifications disabled
            const notifiedToggle = document.createElement("label");
            notifiedToggle.className = "topologygraph-toggle";
            notifiedToggle.title = "Leave out services with notifications disabled from the rings and counts";
            const notifiedBox = document.createElement("input");
            notifiedBox.type = "checkbox";
            notifiedBox.checked = notifiedOnly;
            notifiedBox.addEventListener("change", () => {
                notifiedOnly = notifiedBox.checked;
                updateUrl();
                if (drawn) drawn.restyle();
            });
            notifiedToggle.append(notifiedBox, " Notified services only");

            // Option: fold synthetic hosts' members into them
            const collapseToggle = document.createElement("label");
            collapseToggle.className = "topologygraph-toggle topologygraph-collapse";
            collapseToggle.title = "Show synthetic hosts without their members, to save space";
            collapseToggle.hidden = true;
            const collapseBox = document.createElement("input");
            collapseBox.type = "checkbox";
            collapseBox.checked = collapsed;
            collapseBox.addEventListener("change", () => {
                collapsed = collapseBox.checked;
                updateUrl();
                draw(null);
            });
            collapseToggle.append(collapseBox, " Collapse members");

            // Layout engine: the module's own, ELK (loaded on first use), or the
            // hybrid of the two (ELK, with the rightmost column wrapped)
            const layoutPicker = document.createElement("select");
            layoutPicker.className = "topologygraph-layout";
            layoutPicker.title = "Layout engine";
            [["standard", "Standard layout"], ["elk", "ELK layout"], ["hybrid", "Hybrid layout"]].forEach(([value, label]) => {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = label;
                layoutPicker.append(option);
            });
            layoutPicker.value = layout;
            layoutPicker.addEventListener("change", () => {
                layout = layoutPicker.value;
                updateUrl();
                draw(null);
            });

            controls.append(layoutPicker, notifiedToggle, collapseToggle, groupButton, pickerButton);
            viewport.append(panel, groupPanel);

            const isFullscreen = () =>
                (document.fullscreenElement || document.webkitFullscreenElement) === viewport;
            const canFullscreen = !!(viewport.requestFullscreen || viewport.webkitRequestFullscreen);
            const toggleFullscreen = () => {
                if (isFullscreen()) {
                    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                } else {
                    (viewport.requestFullscreen || viewport.webkitRequestFullscreen).call(viewport);
                }
            };

            let fullscreenButton = null;
            [
                ["+", "Zoom in", () => svg.transition().duration(200).call(zoom.scaleBy, 1.4)],
                ["\u2212", "Zoom out", () => svg.transition().duration(200).call(zoom.scaleBy, 1 / 1.4)],
                ["Fit", "Fit the whole diagram", () => fit(true)],
                ["1:1", "Show at 100%", () => {
                    const t = d3.zoomTransform(svg.node());
                    svg.transition().duration(250).call(zoom.scaleBy, 1 / t.k);
                }],
                canFullscreen ? ["Full screen", "Toggle full screen (Esc to leave)", toggleFullscreen] : null
            ].filter(Boolean).forEach(([label, title, action]) => {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = label;
                button.title = title;
                button.addEventListener("click", event => {
                    event.preventDefault();
                    if (action !== toggleFullscreen) userMoved = true;
                    action();
                });
                controls.append(button);
                if (action === toggleFullscreen) fullscreenButton = button;
            });
            viewport.append(controls);

            const hint = document.createElement("div");
            hint.className = "topologygraph-hint";
            const status = document.createElement("span");
            status.className = "topologygraph-status";
            const layoutNote = document.createElement("span");
            layoutNote.className = "topologygraph-note";
            const groupNote = document.createElement("span");
            groupNote.className = "topologygraph-note";
            hint.append(layoutNote, groupNote, status, "Scroll to zoom \u00b7 Drag or Shift + scroll to move");
            viewport.append(hint);

            // Legend for the colours, bottom left
            const legend = document.createElement("div");
            legend.className = "topologygraph-legend";
            const swatch = (fill, opts = {}) => {
                const ns = "http://www.w3.org/2000/svg";
                const icon = document.createElementNS(ns, "svg");
                icon.setAttribute("width", "20");
                icon.setAttribute("height", "12");
                icon.setAttribute("viewBox", "-10 -6 20 12");
                if (opts.ring) {
                    const ring = document.createElementNS(ns, "circle");
                    ring.setAttribute("r", "5");
                    ring.setAttribute("fill", "none");
                    ring.setAttribute("stroke", opts.ring);
                    ring.setAttribute("stroke-width", "1.5");
                    icon.append(ring);
                }
                const dot = document.createElementNS(ns, "circle");
                dot.setAttribute("r", opts.ring ? "2.5" : "4");
                dot.setAttribute("fill", fill);
                if (opts.faded) dot.setAttribute("fill-opacity", "0.45");
                icon.append(dot);
                return icon;
            };
            // A short arrow, for the two kinds of dependency
            const arrowSwatch = colour => {
                const ns = "http://www.w3.org/2000/svg";
                const icon = document.createElementNS(ns, "svg");
                icon.setAttribute("width", "20");
                icon.setAttribute("height", "12");
                icon.setAttribute("viewBox", "-10 -6 20 12");
                const line = document.createElementNS(ns, "path");
                line.setAttribute("d", "M-9,0H6");
                line.setAttribute("stroke", colour);
                line.setAttribute("stroke-width", "1.6");
                const head = document.createElementNS(ns, "path");
                head.setAttribute("d", "M9,0L4,-3.5L4,3.5Z");
                head.setAttribute("fill", colour);
                icon.append(line, head);
                return icon;
            };
            // A dotted line ending in a diamond, for a synthetic host's members
            const memberSwatch = () => {
                const ns = "http://www.w3.org/2000/svg";
                const icon = document.createElementNS(ns, "svg");
                icon.setAttribute("width", "20");
                icon.setAttribute("height", "12");
                icon.setAttribute("viewBox", "-10 -6 20 12");
                const line = document.createElementNS(ns, "path");
                line.setAttribute("d", "M-2,0H9");
                line.setAttribute("stroke", COLOURS.edge);
                line.setAttribute("stroke-width", "1.4");
                line.setAttribute("stroke-dasharray", "1.5,3");
                line.setAttribute("stroke-linecap", "round");
                const diamond = document.createElementNS(ns, "path");
                diamond.setAttribute("d", "M-9,0L-5.5,-3L-2,0L-5.5,3Z");
                diamond.setAttribute("fill", "none");
                diamond.setAttribute("stroke", COLOURS.edge);
                icon.append(line, diamond);
                return icon;
            };
            [
                [swatch(COLOURS.up), "up"],
                [swatch(COLOURS.down), "down"],
                [swatch(COLOURS.unreachable), "unreachable (parent down)"],
                [swatch(COLOURS.down, {faded: true}), "acknowledged / downtime"],
                [swatch(COLOURS.pending), "pending"],
                [swatch(COLOURS.up, {ring: COLOURS.warning}), "service problem"],
                [arrowSwatch(COLOURS.edge), "within the host group"],
                [arrowSwatch(COLOURS.edgeOutside), "to or from other hosts"]
            ].forEach(([icon, text]) => {
                const item = document.createElement("span");
                item.append(icon, text);
                legend.append(item);
            });
            const memberLegend = document.createElement("span");
            memberLegend.className = "topologygraph-legend-members";
            memberLegend.title = "Dotted, amber while some members are down but enough are up, red when too few are up";
            memberLegend.append(memberSwatch(), "members of a synthetic host");
            memberLegend.hidden = true;
            legend.append(memberLegend);
            // "within the host groups" when several are graphed
            const withinLegend = [...legend.childNodes].find(item => item.textContent === "within the host group").lastChild;
            viewport.append(legend);

            // --- Sizing ----------------------------------------------------------

            container.replaceChildren(viewport);

            const scroller = () => {
                for (let el = viewport.parentElement; el && el !== document.body; el = el.parentElement) {
                    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
                }
                return document.scrollingElement || document.documentElement;
            };
            // Fill the window from the viewport's top edge down to the bottom, and
            // reach into the padding of the surrounding page so the graph runs
            // edge to edge (upwards only if nothing sits above it)
            const sizeToWindow = () => {
                const style = viewport.style;
                if (isFullscreen()) {
                    style.margin = "0";
                    style.width = "100vw";
                    style.height = "100vh";
                    return;
                }
                const outer = scroller();
                let left = 0, right = 0, top = 0, bottom = 0, nothingAbove = !viewport.previousElementSibling;
                for (let el = viewport.parentElement; el && el !== outer && el !== document.body; el = el.parentElement) {
                    const cs = getComputedStyle(el);
                    left += parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
                    right += parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
                    bottom += parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
                    if (nothingAbove) top += parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
                    if (el.previousElementSibling) nothingAbove = false;
                }
                style.margin = `${-top}px ${-right}px ${-bottom}px ${-left}px`;
                style.width = `calc(100% + ${left + right}px)`;
                style.height = Math.max(200, window.innerHeight - viewport.getBoundingClientRect().top) + "px";
                // If the page would still scroll, take that much off
                const excess = outer.scrollHeight - outer.clientHeight;
                if (excess > 0) style.height = Math.max(200, viewport.clientHeight - excess) + "px";
            };

            // Re-lay out (and refit) after the viewport settles at a new size,
            // unless the user has zoomed or panned
            let relayoutTimer = null;
            const sizeChanged = () => Math.abs(viewport.clientWidth - laidOutFor.width) > 20
                || Math.abs(viewport.clientHeight - laidOutFor.height) > 20;
            const relayoutSoon = force => {
                clearTimeout(relayoutTimer);
                relayoutTimer = setTimeout(() => {
                    if (!viewport.isConnected) return;
                    // Check again when it comes due: the drawing may already be
                    // laid out for this size (e.g. the first one, made after the
                    // viewport's initial resize notice but before this timer)
                    if (!force && (userMoved || !sizeChanged())) return;
                    draw(null);
                }, 200);
            };
            if (window.ResizeObserver) {
                new ResizeObserver(() => {
                    if (sizeChanged()) relayoutSoon(false);
                }).observe(viewport);
            }

            const onWindowResize = () => {
                // Icinga replaces the diagram on refresh; drop listeners of old ones
                if (!viewport.isConnected) {
                    window.removeEventListener("resize", onWindowResize);
                    return;
                }
                sizeToWindow();
            };
            window.addEventListener("resize", onWindowResize);
            const onFullscreenChange = () => {
                if (!viewport.isConnected) {
                    document.removeEventListener("fullscreenchange", onFullscreenChange);
                    document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
                    return;
                }
                sizeToWindow();
                if (fullscreenButton) fullscreenButton.textContent = isFullscreen() ? "Exit full screen" : "Full screen";
                relayoutSoon(true);
            };
            document.addEventListener("fullscreenchange", onFullscreenChange);
            document.addEventListener("webkitfullscreenchange", onFullscreenChange);

            sizeToWindow();

            return {
                isConnected: () => viewport.isConnected,
                progress,
                progressFailed,
                setStatus: text => { status.textContent = text ? text + " \u00b7 " : ""; },
                // New data: recolour in place if the shown hosts and dependencies
                // are unchanged, else re-lay out (keeping the user's view,
                // unless other host groups were chosen: reset)
                setData: (data, reset) => {
                    fullData = {nodes: data.nodes || [], links: data.links || []};
                    hasData = true;
                    if (reset) userMoved = false;
                    // Older servers sent one host group, and nothing to choose from
                    graphedGroups = data.hostgroups || [data.hostgroup || "synthetic"];
                    defaultGroup = data.hostgroup_default || graphedGroups[0];
                    offeredGroups = data.hostgroups_offered || graphedGroups.map(name => ({name, label: name}));
                    const ignored = ignoredGroups = data.hostgroups_ignored || [];
                    if (ignored.length) {
                        // Drop them from the address, as for unknown hosts
                        selectedGroups = selectedGroups.filter(name => !ignored.includes(name));
                        updateUrl();
                    }
                    groupNote.textContent = ignored.length
                        ? "Not offered in the module settings: " + ignored.join(", ") + " \u00b7 "
                        : "";
                    // Only offered when there is something to collapse
                    collapseToggle.hidden = !fullData.nodes.some(n => n.aggregate);
                    withinLegend.textContent = graphedGroups.length > 1 ? "within the host groups" : "within the host group";
                    updateGroupPicker();
                    updatePicker();
                    const visible = visibleData();
                    if (!reset && drawn && structureOf(visible) === drawn.structure) {
                        drawn.update(visible);
                    } else {
                        draw(drawn && userMoved ? d3.zoomTransform(svg.node()) : null);
                    }
                }
            };
        }
    };

    Icinga.availableModules.topologygraph = Topologygraph;

}(Icinga));
