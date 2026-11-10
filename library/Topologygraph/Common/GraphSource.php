<?php

namespace Icinga\Module\Topologygraph\Common;

/**
 * Fetches just what the graph needs from the Icinga 2 API, in small requests
 * filtered on the Icinga side, and builds the graph with GraphBuilder:
 *
 * 1. the hosts in the group(s)
 * 2. the host-to-host dependencies that touch them
 * 3. the hosts outside the group at the other end of those dependencies
 * 4. the host-to-host dependencies between those outside hosts (adds lines
 *    between hosts already drawn, never more hosts)
 * 5. the services of all drawn hosts (optional: without permission, or on
 *    error, the graph is built without service details)
 * 6. only if a synthetic host has members that aren't drawn: their states,
 *    to tell how many of its members are up
 *
 * The API is passed in as a callable so this can be tested without Icinga.
 */
final class GraphSource
{
    const HOST_ATTRS = 'attrs=name&attrs=display_name&attrs=state&attrs=last_check&attrs=groups&attrs=zone'
        . '&attrs=last_reachable&attrs=acknowledgement&attrs=downtime_depth&attrs=vars';
    // Just enough to tell whether a synthetic host's member is up
    const MEMBER_ATTRS = 'attrs=name&attrs=state&attrs=last_check';
    const DEPENDENCY_ATTRS = 'attrs=parent_host_name&attrs=child_host_name&attrs=child_service_name';
    const SERVICE_ATTRS = 'attrs=host_name&attrs=state&attrs=last_check&attrs=acknowledgement&attrs=downtime_depth'
        . '&attrs=enable_notifications';

    /**
     * @param callable $api      function (string $endpoint, array $body): array of API results
     * @param string|string[] $group Host group(s) to draw
     * @param string   $hostPath Icinga Web URL prefix for a host's detail page
     * @param callable $onServiceError Optional: called with the exception if services can't be fetched
     *
     * @return array ['nodes' => [...], 'links' => [...]]
     */
    public static function fetch(callable $api, $group, $hostPath, ?callable $onServiceError = null)
    {
        $groups = array_values(array_unique(array_map('strval', (array) $group)));
        $groupHosts = $api('objects/hosts?' . self::HOST_ATTRS, self::inGroups($groups));
        $groupNames = self::names($groupHosts);
        if (! $groupNames) {
            return GraphBuilder::build(GraphBuilder::select([], [], $groups), [], [], $hostPath);
        }

        $dependencies = $api(
            'objects/dependencies?' . self::DEPENDENCY_ATTRS,
            [
                'filter'      => 'dependency.child_service_name == ""'
                    . ' && (dependency.parent_host_name in names || dependency.child_host_name in names)',
                'filter_vars' => ['names' => $groupNames]
            ]
        );

        $selection = GraphBuilder::select($groupHosts, $dependencies, $groups);

        $neighbours = array_values(array_diff($selection['names'], $groupNames));
        $neighbourHosts = $neighbours ? $api(
            'objects/hosts?' . self::HOST_ATTRS,
            ['filter' => 'host.name in names', 'filter_vars' => ['names' => $neighbours]]
        ) : [];

        // Dependencies between two drawn hosts outside the group (e.g. a host
        // in the DMZ and one in the backend) touch no group host, so step 2
        // doesn't find them
        if (count($neighbours) > 1) {
            $selection = GraphBuilder::addLinksAmong($selection, $api(
                'objects/dependencies?' . self::DEPENDENCY_ATTRS,
                [
                    'filter'      => 'dependency.child_service_name == ""'
                        . ' && dependency.parent_host_name in names && dependency.child_host_name in names',
                    'filter_vars' => ['names' => $neighbours]
                ]
            ));
        }

        try {
            $services = $api(
                'objects/services?' . self::SERVICE_ATTRS,
                ['filter' => 'host.name in names', 'filter_vars' => ['names' => $selection['names']]]
            );
        } catch (\Exception $e) {
            if ($onServiceError !== null) {
                $onServiceError($e);
            }
            $services = null;
        }

        // States of synthetic hosts' members that aren't drawn
        $fetched = array_merge($groupHosts, $neighbourHosts);
        $missing = array_values(array_diff(
            GraphBuilder::aggregateMembers($fetched),
            self::names($fetched)
        ));
        $memberHosts = $missing ? $api(
            'objects/hosts?' . self::MEMBER_ATTRS,
            ['filter' => 'host.name in names', 'filter_vars' => ['names' => $missing]]
        ) : [];

        return GraphBuilder::build($selection, array_merge($fetched, $memberHosts), $services, $hostPath);
    }

    /**
     * API filter for the hosts in any of the groups
     *
     * @param string[] $groups
     *
     * @return array
     */
    public static function inGroups(array $groups)
    {
        if (count($groups) === 1) {
            return ['filter' => 'group in host.groups', 'filter_vars' => ['group' => $groups[0]]];
        }
        $terms = $vars = [];
        foreach ($groups as $i => $group) {
            $terms[] = 'group' . $i . ' in host.groups';
            $vars['group' . $i] = $group;
        }

        return ['filter' => implode(' || ', $terms), 'filter_vars' => $vars];
    }

    private static function names(array $hosts)
    {
        return array_values(array_map(function ($host) {
            return (string) $host['name'];
        }, $hosts));
    }
}
