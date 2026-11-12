# Topology Graph for Icinga Web 2

`topologygraph` is an Icinga Web 2 module that draws a **parent/child topology graph of the hosts in one or more host
groups** (`synthetic` by default, others chosen on the page), with their state, their service problems and live updates.

It started as a fork of [sol1/icinga-clustergraph](https://github.com/sol1/icinga-clustergraph), which draws the
Icinga 2 cluster: zones, the endpoints in each zone, and which zone reports to which parent. This fork reused that
module's settings page and API plumbing, then replaced what it draws. It was renamed from `clustergraph` to
`topologygraph` so the two can't be confused and can be installed side by side. See
[Upgrading from clustergraph](#upgrading-from-clustergraph).

## How the module was repurposed

The upstream module asks the Icinga 2 API for zones and endpoints and draws them as a tree. This fork swaps both ends:

- **Data:** `IndexController::dataAction()` asks the API for hosts, `Dependency` objects and services instead of
  zones. It returns every host in the chosen host groups, plus any direct parent or child of one that is outside
  the group, and the parent → child links between all of these, including between two hosts outside the group. Only host-to-host dependencies are used; service
  dependencies are ignored.
- **Drawing:** `public/js/module.js` replaces the zone tree with a layered dependency graph built with D3, described
  below.
- **Permissions:** the API user needs `objects/query/Host`, `objects/query/HostGroup`, `objects/query/Dependency`
  and `objects/query/Service` instead of the zone and endpoint permissions.

The settings page and the API connection work as they did upstream, with three new settings: the default host
group, the host groups offered on the page, and the refresh interval.

## What the graph shows

- **Layout:** parents are on the right and children on the left. Each arrow points from a child up to its parent, the way
  parents are configured and data usually flows.
- **Rightmost column:** hosts with no parents (typically the synthetic checks themselves) form the rightmost level.
  Hosts that are parents of exactly the same children are drawn together in one rounded box with a single exit point
  for their arrows. That column is wrapped into several side-by-side sub-columns, so a long list of checks doesn't
  make the graph very tall.
- **Boxes further left:** hosts that have the same parents and the same children as each other, at least two of
  them, are also drawn together in a box. The box then has one arrow to each parent and each child has one arrow
  to the box, instead of an arrow per host, so a farm of identical web or app servers reads as one step in the
  chain. An arrow from a box turns red (or purple) when every host in it is down, and is dashed in that colour
  while only some are, so one worker down in a pool doesn't look like the whole pool failing.
- **Colours:** dots and names show host state: green for up, red for down, purple for unreachable (down only
  because a parent is down), blue for pending, grey for unknown. Problems that are acknowledged or in downtime are
  faded.
- **Arrows:** blue between hosts of the graphed groups, gray when a host outside them is at either end (a dependency
  that ties other hosts into the graph). Both are drawn at the same width, opacity and lightness. An arrow from a host that is down or unreachable takes that host's colour
  either way.
- **Redundancy groups:** dependencies with Icinga's `redundancy_group` mean the child needs any one parent of the
  group, not all of them. Each of those parents gets its own dashed arrow, and the arrows fork off a small hollow
  circle next to the child, so a pair of symmetric services in two data centres reads as "either one". A parent
  without a redundancy group keeps a plain arrow: it is required. The colours show how much redundancy is left:
  an arrow to a parent that is down is amber while another parent of the group is up, and red when none is. The
  hover text lists each group, for example `redundancy group svc: 1 of 2 parents up (down: svc-dc1)`. Alternative
  parents are never boxed together, so each keeps its own arrow.
- **Synthetic hosts with members:** synthetic hosts are read the way
  [python-icinga2-aggregator](https://github.com/gunther788/python-icinga2-aggregator) reads them: a host with
  `vars.synthetic.members` (and/or `vars.synthetic.member_groups`, whose hosts are added) aggregates those
  members, in the mode set by `vars.synthetic.mode`. Its members meet it on a dotted line ending in a hollow
  diamond, with no arrowhead, so membership doesn't read as a dependency. Members are drawn whether or not they
  are also parents: the line comes from the variables, and replaces the dependency arrow if there is one. A badge
  left of the host's name shows how many members it needs out of all of them, and how many are healthy, for
  example `2 of 3 · 2 up`:

  | `vars.synthetic.mode` | Members needed |
  |---|---|
  | `any` | 1 |
  | `all` (or not set) | all of them |
  | `quorum` | `vars.synthetic.quorum`: a count, or a percentage such as `"66%"` (rounded up); by default a majority |
  | a number, e.g. `"2"` | that many (at most all) |

  **Members checked from several zones:** host objects with the same `vars.real_host` (a host without it stands
  for itself) are the *sources* of one member, e.g. `acme` from its home zone and `acme-stag` and `acme-cloud`
  with `vars.real_host = "acme"`. Listing any of them adds the member once, with all its sources: every source is
  drawn with a membership line, but counts are per real host. `vars.synthetic.sources` decides how a member's
  sources combine: `best` (default: up if any source is up), `worst`, `majority`, or `home` (the object with
  `vars.home = true`, else the one named like the real host; `best` while it has no result).

  The counts come from the aggregator itself when it has written its result: the performance data
  `healthy=<n>;;<required>:;0;<total>` of the synthetic host's `health` service. The hover text then also shows
  the aggregator's result line. Without it, the counts are worked out here from the sources' host states by the
  same rules, including members that aren't drawn.

  The line and the badge are neutral while every member is healthy, amber while some aren't but enough are, and
  red when too few are. Hover over the host to see which members are down.

  Members don't need to be parents, and usually shouldn't be. Each Icinga `Dependency` counts on its own, so
  with every member as a parent, one member down makes the synthetic host unreachable, and its notifications are
  suppressed while quorum still holds, and again when quorum is lost. Hosts depending on the synthetic host can
  be treated as unreachable too. Keep `parents` for what the synthetic host really depends on, or put the
  member dependencies in one `redundancy_group`.

  To save space, tick **Collapse members** (kept in the page address as `members=collapsed`). Members whose only
  children are synthetic hosts they belong to are then left out, and the synthetic host takes over their parents:
  `dc2_worker_xray2` then points straight at `dc2_master_xray2`. The badge still shows the margin, and the hover
  text lists the collapsed members. A member with other children stays, so no dependency is hidden. The option
  only appears when the graph has synthetic hosts.
- **Service problems:** a ring around a host's dot shows its worst service problem: red for critical, orange for
  warning, purple for unknown. The ring is solid while any problem is unhandled, and dashed and faded when all of
  them are acknowledged or in downtime. A legend in the bottom-left corner explains the colours.
- **Hosts outside the group:** they're drawn faded and in italics. "The group" is the host group being graphed, or
  any of them when several are.
- **Hovering a host:** highlights everything above and below it, along with the arrows on those chains, and dims
  the rest. The hover text shows the host's state, its service counts and its zone. Click a host to open it in
  Icinga Web.

The layout tries to:

- keep arrows horizontal, by lining each host up with one of the hosts it connects to;
- cross as few arrows as possible, and avoid running arrows through boxes or host names;
- match the shape of the browser window, so the diagram fills it at full text size.

## Using it

- **Moving around:**
  - Scroll the mouse wheel, or pinch on a trackpad, to zoom in and out around the pointer.
  - Drag to move the diagram, or hold Shift and scroll.
- **Buttons** (top right): zoom in, zoom out, **Fit** (the whole diagram), **1:1** (100%) and **Full screen** (Esc to
  leave).
- **Choosing host groups:** the host group button (it shows the group being graphed) lists the host groups offered
  in the module settings, with a filter box. Tick one or several: the graph then has the hosts of all ticked
  groups, drawn as members, plus the hosts with a direct dependency on one of them, drawn as outside hosts. Changing
  the groups loads a new graph. **Default** goes back to the default host group. The button is hidden when the
  settings offer only the default.
- **Showing a subset:** the host button (it reads **All hosts ▾** until you choose) opens a checklist, with a filter
  box, of every host without children in the graph. The graph then shows the ticked hosts plus everything above
  them: their parents, their parents' parents, and so on. **Show all** goes back to everything.
- **Bookmarking:** both choices are kept in the page address, as repeated `hostgroup` and `host` parameters.
  Bookmark or share it like any other link, for example:

  ```
  https://icinga.example.com/icingaweb2/topologygraph?hostgroup=databases
  https://icinga.example.com/icingaweb2/topologygraph?hostgroup=databases&hostgroup=messaging
  https://icinga.example.com/icingaweb2/topologygraph?host=db-1&host=cache-1&hostgroup=databases
  ```

  Group names are the Icinga object names, not display names. Unknown hosts are ignored, and so are host groups the
  settings don't offer: the page drops them from the address and says so at the bottom.

- **Collapsing members:** **Collapse members** leaves out synthetic hosts' members and draws the synthetic hosts
  in their place, as `members=collapsed`. See [What the graph shows](#what-the-graph-shows).
- **Ignoring services without notifications:** tick **Notified services only** to leave out services that have
  notifications disabled. They then don't count towards the service rings or the counts in the hover text. The
  option is kept in the page address as `services=notified`, and combines with a host selection, for example
  `…/topologygraph?host=db-1&services=notified`.
- **Layout engine:** the **Layout** menu in the controls switches between the module's own **Standard layout**, the
  **ELK layout** (the Eclipse Layout Kernel) and the **Hybrid layout** of the two. The choice is kept in the page
  address as `layout=elk` or `layout=hybrid`. See [Layout engines](#layout-engines).
- **Loading:** while the data is fetched and the graph laid out, a card in the middle shows what is happening, with
  a progress bar. Later re-layouts, for example after choosing a subset, show a slim bar at the top instead.
- **Live updates:** while the page is visible, the graph fetches fresh data at the refresh interval (15 seconds by
  default) and catches up straight away when you return to the tab. A change of host state only recolours the existing drawing, so your zoom and
  position stay put. If hosts or dependencies were added or removed, the graph is laid out again. The bottom-right
  corner shows when it last updated.

## Layout engines

**Standard layout** (the default) is the module's own:

- the rightmost groups are wrapped into side-by-side lists, so many checks don't make the graph tall;
- the diagram's shape follows the window;
- arrows are smooth curves.

**ELK layout** uses the layered algorithm of the [Eclipse Layout Kernel](https://eclipse.dev/elk/), through
[elkjs](https://github.com/kieler/elkjs):

- arrows are routed at right angles around hosts and boxes, and never run through them;
- hosts without parents are placed next to their children instead of always on the far right;
- more arrows come out level;
- but the rightmost groups form a single column, which gets tall with many checks;
- arrows from the same host share their first stretch;
- the diagram doesn't spread out to fill the window.

**Hybrid layout** is ELK with the standard layout's wrapping: when the rightmost column of boxes is much taller than
the rest, it is split into side-by-side columns, as many as it takes to show the diagram as large as possible in the
window. The boxes are dealt out in turn from top to bottom, so each column covers the whole height and boxes stay
level with their children. ELK still places everything and routes the arrows. It runs ELK twice, once to see the
shape and once for the final layout.

On the test samples (1400×800 window):

| sample | layout | crossings | arrows through boxes/labels | level arrows | shown at |
|---|---|---|---|---|---|
| 23 parents | standard | 2 | 1 | 6/14 | 100% |
| 23 parents | ELK / hybrid | 4 | 0 | 6/14 | 100% |
| random 40 | standard | 13 | 6 | 0/26 | 100% |
| random 40 | ELK | 10 | 0 | 6/26 | 64% |
| random 40 | hybrid | 10 | 0 | 7/26 | 100% |

When the rightmost column isn't too tall, as in the 23-parent sample, hybrid and ELK give the same picture. To compare the two on your own hosts, save the output of `…/topologygraph/index/data` to a file and
run `npm run compare -- that-file.json` in `tests/`. See [tests/README.md](tests/README.md).

ELK is about 1.6 MB, so it isn't loaded with every Icinga Web page. The module serves it from
`…/topologygraph/index/elk`, and the browser fetches it, and caches it, only when the ELK layout is chosen. If it
can't be loaded, the standard layout is used and the reason is shown in the bottom-right corner.

With either engine, hosts glide to their new places when the graph is laid out again, unless the viewer's system
asks for reduced motion.

## Prerequisites

- Icinga Web 2, with the icinga-php-library (0.11.0 or later)
- Icinga 2 with the REST API enabled and an API user (see below)
- A host group to draw by default (`synthetic` unless you choose another in the settings)
- Host parent/child relationships defined as Icinga 2 `Dependency` objects

The graph is built from `Dependency` objects only. If your parents are kept in a custom variable, add an apply rule
that turns it into dependencies, for example:

```
apply Dependency "host-parent" for (parent in host.vars.parents) to Host {
  parent_host_name = parent
  assign where host.vars.parents
}
```

## Installation

1. Clone the repository into the Icinga Web 2 `modules` directory as `topologygraph` (the folder name must match the
   module name):

   ```
   git clone https://github.com/gunther788/icinga-topologygraph.git /usr/share/icingaweb2/modules/topologygraph
   ```

2. Enable the module in the Icinga Web 2 web interface, or on the command line:

   ```
   icingacli module enable topologygraph
   ```

## Configuration

1. Add an API user to Icinga 2, for example in `api-users.conf`:

   ```
   object ApiUser "topologygraph" {
     password = "change-me"
     permissions = [ "objects/query/Host", "objects/query/HostGroup", "objects/query/Dependency", "objects/query/Service" ]
   }
   ```

2. In Icinga Web 2, go to **Configuration → Modules → topologygraph → Config**.
3. Fill in the settings:
   - **API user, password, endpoint (host name) and port** of the Icinga 2 API;
   - **Web UI:** where host links open, Icinga Web 2 (monitoring) or Icinga DB Web;
   - **Default host group:** graphed until another is chosen on the page (default `synthetic`);
   - **Offered host groups:** the host groups that can be chosen on the page, one pattern per line (see below);
   - **Refresh interval:** seconds between updates while the graph is open (default 15, at least 5).
4. Save the changes, then open **Topology Graph** from the menu.

Without `objects/query/Service` the graph still works, but without service rings. The hover text then says that
service details are not available. Without `objects/query/HostGroup`, only the default host group is offered.

### Offered host groups

With many host groups, the page offers only those matching the patterns in **Offered host groups**, one per line,
matched against the host group's object name:

```
synthetic
app-*
dc-?-backend
!*-test
```

- A name without wildcards offers exactly that group.
- `*` matches any characters, and `?` matches exactly one.
- A line starting with `!` leaves out the groups it matches, even when another line matches them. Above, `app-shop`
  is offered, but `app-shop-test` isn't.
- The default host group is always offered.
- Left empty, only the default host group is offered, which is how the module worked before this setting.

This list is also the allowlist: a `hostgroup=` in the page address that isn't offered is ignored, so nobody can
graph other host groups by editing the address. The patterns are matched on the Icinga side with `match()`, so only
the matching groups are fetched, and the list is cached for five minutes. The settings page stores the patterns on
one line, separated by commas.

Font size and spacing are constants (`FONT_SIZE` and `BASE`) near the top of `public/js/module.js`.

## Why is a host missing, or gray?

The graph has the hosts in the graphed host groups, plus the hosts with a host-to-host dependency on one of them.
Only hosts in the graphed groups are drawn as members (bold, blue arrows); all others are drawn as outside hosts
(gray). So a host is missing if it has no dependency to or from a host of the graphed groups, and it is gray if it
isn't in one of them itself. Ticking hosts in the host checklist only narrows the graph; it never adds hosts.

To see this for your hosts, open **Explain this view as JSON** at the foot of the host checklist, or the address
directly:

```
https://icinga.example.com/icingaweb2/topologygraph/index/explain?hostgroup=webservers&host=web-7
```

It takes the same `hostgroup` and `host` parameters as the graph page and returns:

- `hosts`: every drawn host, with
  - `drawn_as` (`member` or `outside`) and `why_drawn`, for example `in host group webservers` or `child of
    probe-a`;
  - `groups`, `parents` and `children`;
  - `shown` and `why_shown` for the host selection, for example `selected` or `parent of shown host web-1`.
- `links`: every line, and whether it `touches a member` or is `between two outside hosts`.
- `selected_but_not_drawn`: the selected hosts that are not in the graph, with the reason and their host-to-host
  dependencies.
- `hostgroups_ignored`: groups in the address that the settings don't offer.

For selected hosts that aren't drawn, this makes two more API requests (those hosts and their dependencies), which
are not cached.

## Load on the Icinga API

Each update makes a handful of small requests, each filtered on the Icinga side:

1. the hosts in the graphed groups;
2. the host-to-host dependencies that touch them;
3. only with synthetic hosts in the groups: their members, with every source of each (`host.name in names ||
   host.vars.real_host in names`; a second round when a listed member is itself another host's source), and the
   hosts of their `member_groups`;
4. the hosts outside the groups at the other end of the dependencies;
5. the dependencies between those outside hosts, for example between a host in the DMZ and one in the backend. This
   adds lines between hosts that are already drawn, never more hosts;
6. the services of all drawn hosts;
7. only with synthetic hosts drawn outside the groups: their members and sources, for the counts;
8. only with synthetic hosts: the aggregator's results, from their `health` services.

Host requests include the hosts' custom variables, to read `vars.synthetic`, `vars.real_host` and `vars.home`;
only a summary of each aggregation is sent on to the page.

The finished graph is cached on the Icinga Web server for half the refresh interval, separately for each combination
of host groups, in a folder in the system's temporary directory. Several people looking at the same host groups
therefore share one set of requests. Failed requests are not cached.

The list of offered host groups is one more request, cached for five minutes. It is made only when the settings
offer more than the default host group.

## Upgrading from clustergraph

If you ran this fork under its old name, `clustergraph`:

1. Disable the old module:

   ```
   icingacli module disable clustergraph
   ```

2. Rename the module folder, point it at the renamed repository and update it:

   ```
   mv /usr/share/icingaweb2/modules/clustergraph /usr/share/icingaweb2/modules/topologygraph
   git -C /usr/share/icingaweb2/modules/topologygraph remote set-url origin https://github.com/gunther788/icinga-topologygraph.git
   git -C /usr/share/icingaweb2/modules/topologygraph pull
   ```

   GitHub redirects the old `icinga-clustergraph` address, so a pull works without changing the remote, but the new
   address is safer.

3. Move the settings:

   ```
   mv /etc/icingaweb2/modules/clustergraph /etc/icingaweb2/modules/topologygraph
   ```

4. Enable the new module:

   ```
   icingacli module enable topologygraph
   ```

5. Update anything that refers to the old name:
   - bookmarks, which now start `…/topologygraph` instead of `…/clustergraph`;
   - Icinga Web roles that grant `module/clustergraph`, which should grant `module/topologygraph`.

Add `objects/query/Service` and `objects/query/HostGroup` to the API user's permissions if it doesn't have them
yet.

### Bookmarks with `hostgroup=`

`hostgroup=` used to narrow the graph of the configured host group to the hosts of another group, and everything
above them. It now chooses which host groups to graph, so such a bookmark shows that group's hosts and their direct
neighbours instead, and only if the group is offered in the settings. `host=` bookmarks work as before.

## Tests

The `tests/` folder has PHP tests for the data the module sends and browser tests for the graph itself. See
[tests/README.md](tests/README.md) for how to run them.

## Limitations

- On very large graphs (more than 400 arrows) the slower layout refinements are skipped to keep the page
  responsive, so the layout may be less tidy.
- Only one arrow into a host can be level when its parents sit at different heights, so graphs where most hosts have
  several parents will still have sloped arrows.
- On touch devices, dragging on the graph moves the diagram instead of scrolling the page.

## Contributing

Changes go to https://github.com/gunther788/icinga-topologygraph. The original zone and endpoint graph lives
upstream at https://github.com/sol1/icinga-clustergraph.

## License

All code here is licensed under GPL V2, except the bundled libraries in `public/js/vendor/`:

- D3: ISC licence;
- elkjs (`public/js/vendor/elkjs/`): EPL-2.0 OR GPL-3.0-or-later, see the `LICENSE.md` file there.
