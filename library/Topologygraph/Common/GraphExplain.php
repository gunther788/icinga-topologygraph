<?php

namespace Icinga\Module\Topologygraph\Common;

/**
 * Explains a graph built by GraphSource, for comparing it with Icinga or
 * other reference data:
 *
 * - every drawn host, whether it is drawn as a member of the graphed host
 *   groups (bold, blue arrows) or as a host outside them (gray), and why it is
 *   in the graph at all;
 * - every line, and which request found it;
 * - for a host selection (host= in the page address), which drawn hosts it
 *   shows and why;
 * - the selected hosts that are not in the graph, with the host-to-host
 *   dependencies they do have.
 *
 * The API is passed in as a callable, as for GraphSource.
 */
final class GraphExplain
{
    /**
     * @param array    $graph   As returned by GraphSource::fetch()
     * @param string[] $groups  The host groups graphed
     * @param string[] $hosts   Hosts selected by name (host=)
     * @param callable $api     function (string $endpoint, array $body): array of API results
     *
     * @return array
     */
    public static function explain(array $graph, array $groups, array $hosts, callable $api)
    {
        $groups = array_values(array_unique(array_map('strval', $groups)));
        $hosts = array_values(array_unique(array_map('strval', $hosts)));
        $groupList = implode(', ', $groups);
        $groupWords = (count($groups) === 1 ? 'the ' . $groupList . ' host group' : 'the host groups ' . $groupList);

        $nodes = [];
        foreach ($graph['nodes'] as $node) {
            $nodes[(string) $node['name']] = $node;
        }
        $parents = $children = [];
        foreach ($graph['links'] as $link) {
            $parents[$link['target']][] = $link['source'];
            $children[$link['source']][] = $link['target'];
        }
        $isMember = function ($name) use ($nodes) {
            return isset($nodes[$name]) && ! empty($nodes[$name]['member']);
        };

        // What the selection shows, as the page works it out: the selected
        // hosts, then everything above them
        $whyShown = [];
        foreach ($hosts as $name) {
            if (isset($nodes[$name])) {
                $whyShown[$name] = ['selected'];
            }
        }
        $queue = array_keys($whyShown);
        while ($queue) {
            $name = array_shift($queue);
            foreach ($parents[$name] ?? [] as $parent) {
                if (! isset($whyShown[$parent])) {
                    $whyShown[$parent] = ['parent of shown host ' . $name];
                    $queue[] = $parent;
                }
            }
        }

        $explained = [];
        foreach ($nodes as $name => $node) {
            $member = $isMember($name);
            $why = [];
            if ($member) {
                foreach (array_intersect($groups, $node['groups']) as $group) {
                    $why[] = 'in host group ' . $group;
                }
            } else {
                foreach ($children[$name] ?? [] as $child) {
                    if ($isMember($child)) {
                        $aggregate = $nodes[$child]['aggregate'] ?? null;
                        $why[] = ($aggregate && in_array($name, $aggregate['members'], true) ? 'member of ' : 'parent of ')
                            . $child;
                    }
                }
                foreach ($parents[$name] ?? [] as $parent) {
                    if ($isMember($parent)) {
                        $why[] = 'child of ' . $parent;
                    }
                }
            }
            $explained[] = [
                'name'         => $name,
                'display_name' => $node['label'],
                'drawn_as'     => $member ? 'member' : 'outside',
                'why_drawn'    => $why,
                'groups'       => $node['groups'],
                'parents'      => $parents[$name] ?? [],
                'children'     => $children[$name] ?? [],
                'shown'        => ! $hosts || isset($whyShown[$name]),
                'why_shown'    => $hosts ? ($whyShown[$name] ?? []) : ['no hosts selected: everything is shown']
            ];
        }
        usort($explained, function ($a, $b) {
            return [$a['drawn_as'] !== 'member', $a['name']] <=> [$b['drawn_as'] !== 'member', $b['name']];
        });

        $links = [];
        foreach ($graph['links'] as $link) {
            $entry = [
                'parent' => $link['source'],
                'child'  => $link['target'],
                'found'  => $isMember($link['source']) || $isMember($link['target'])
                    ? 'touches a member'
                    : 'between two outside hosts'
            ];
            if (! empty($link['redundancy_group'])) {
                // Any one parent of the group will do
                $entry['redundancy_group'] = $link['redundancy_group'];
            }
            $links[] = $entry;
        }

        // Selected hosts that aren't in the graph, and why
        $notDrawn = [];
        $missingNames = array_values(array_filter($hosts, function ($name) use ($nodes) {
            return ! isset($nodes[$name]);
        }));
        if ($missingNames) {
            $found = [];
            foreach ($api(
                'objects/hosts?attrs=name&attrs=display_name&attrs=groups',
                ['filter' => 'host.name in names', 'filter_vars' => ['names' => $missingNames]]
            ) as $host) {
                $found[(string) $host['name']] = $host;
            }
            $byHost = [];
            if ($found) {
                foreach ($api(
                    'objects/dependencies?' . GraphSource::DEPENDENCY_ATTRS,
                    [
                        'filter'      => 'dependency.child_service_name == ""'
                            . ' && (dependency.parent_host_name in names || dependency.child_host_name in names)',
                        'filter_vars' => ['names' => array_map('strval', array_keys($found))]
                    ]
                ) as $dependency) {
                    $parent = (string) $dependency['attrs']['parent_host_name'];
                    $child = (string) $dependency['attrs']['child_host_name'];
                    $entry = ['parent' => $parent, 'child' => $child];
                    foreach (array_unique([$parent, $child]) as $end) {
                        if (isset($found[$end]) && ! in_array($entry, $byHost[$end] ?? [], true)) {
                            $byHost[$end][] = $entry;
                        }
                    }
                }
            }
            foreach ($missingNames as $name) {
                if (! isset($found[$name])) {
                    $notDrawn[] = ['name' => $name, 'reason' => 'Icinga has no host with this name'];
                    continue;
                }
                $deps = $byHost[$name] ?? [];
                $toDrawn = array_values(array_unique(array_filter(array_map(function ($d) use ($name) {
                    return $d['parent'] === $name ? $d['child'] : $d['parent'];
                }, $deps), function ($other) use ($nodes) {
                    return isset($nodes[$other]);
                })));
                if (! $deps) {
                    $reason = 'it has no host-to-host dependencies at all';
                } elseif ($toDrawn) {
                    $reason = 'it only depends on (or is depended on by) hosts outside them ('
                        . implode(', ', $toDrawn) . '); the graph draws the groups and their direct neighbours only';
                } else {
                    $reason = 'none of its host-to-host dependencies lead to a host in the graph';
                }
                $host = $found[$name];
                $notDrawn[] = [
                    'name'              => $name,
                    'display_name'      => $host['attrs']['display_name'] ?? $name,
                    'groups'            => array_values(array_map('strval', (array) ($host['attrs']['groups'] ?? []))),
                    'reason'            => 'not in ' . $groupWords . ', and ' . $reason,
                    'host_dependencies' => $deps
                ];
            }
        }

        $members = count(array_filter(array_keys($nodes), $isMember));
        return [
            'hostgroups'   => $groups,
            'hosts_selected' => $hosts,
            'counts'       => [
                'drawn'           => count($nodes),
                'drawn_as_member' => $members,
                'drawn_outside'   => count($nodes) - $members,
                'links'           => count($links),
                'shown'           => count(array_filter($explained, function ($h) {
                    return $h['shown'];
                })),
                'selected_but_not_drawn' => count($notDrawn)
            ],
            'how_it_works' => [
                'The graph has the hosts in ' . $groupWords . ', plus the hosts with a host-to-host dependency'
                    . ' on one of them.',
                'Hosts in ' . $groupWords . ' are drawn as members (bold, blue arrows); the others as outside'
                    . ' hosts (gray).',
                'Selecting hosts (host=) only picks from the hosts in the graph: the selected hosts and'
                    . ' everything above them are shown.'
            ],
            'selected_but_not_drawn' => $notDrawn,
            'hosts'        => $explained,
            'links'        => $links
        ];
    }
}
