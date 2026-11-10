// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import queryString from 'query-string';

import SpanFilterButton from './ServiceFilter';
import { getSelectedSpanID, useTraceTimelineStore } from './store';
import {
  decodeSvcFilter,
  encodeSvcFilter,
  getSortedServiceNames,
  SVC_FILTER_DEFAULTS_KEY,
  SvcFilterDefaults,
} from '../url/svcFilter';
import {
  decodeClause,
  encodeClause,
  evaluateSpanFilter,
  hiddenServices,
  IClause,
  isServiceHideClause,
  ISpanFilter,
  spanFiltersEqual,
  TreeMode,
  withHiddenServices,
  normalizeFilter,
} from '../spanFilter';
import { IOtelTrace } from '../../../types/otel';
import { TNil } from '../../../types';
import type { SpanDetailPanelMode } from '../../../types/config';
import { useConfig } from '../../../hooks/useConfig';
import storage from '../../../utils/storage';
import defaultConfig from '../../../constants/default-config';

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

/**
 * Sanitize a pruned set against root service protection rules:
 * - If there's a single root service, it must not be pruned.
 * - If all root services would be pruned, discard the filter entirely.
 */
function sanitizePrunedServices(pruned: Set<string>, rootServiceNames: Set<string>): Set<string> {
  if (pruned.size === 0) return pruned;
  if (rootServiceNames.size === 1) {
    const rootName = rootServiceNames.values().next().value as string;
    if (pruned.has(rootName)) {
      const sanitized = new Set(pruned);
      sanitized.delete(rootName);
      return sanitized;
    }
    return pruned;
  }
  // Multiple roots: ensure at least one root remains visible.
  let anyRootVisible = false;
  for (const name of rootServiceNames) {
    if (!pruned.has(name)) {
      anyRootVisible = true;
      break;
    }
  }
  return anyRootVisible ? pruned : new Set();
}

const CLAUSE_PARAM = 'f';
const TREE_PARAM = 'tree';
const LIFT_VALUE = 'lift';

/**
 * Whether the URL states the filter through any of its parameters, in which case no view default
 * applies and an empty clause list is written as an empty `f` to keep it that way.
 */
function urlSpeaks(params: queryString.ParsedQuery): boolean {
  return CLAUSE_PARAM in params || TREE_PARAM in params || 'svcFilter' in params;
}

function paramValues(value: string | (string | null)[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');
}

/**
 * Reads the saved default, the pruned service names that "Save as Default" writes under
 * SVC_FILTER_DEFAULTS_KEY; it applies when the trace has those services and at least one of them
 * stays visible.
 */
function readDefaultServices(
  sortedServiceNames: string[],
  rootServiceNames: Set<string>,
  treeMode: TreeMode
): Set<string> | null {
  const defaults = storage.getJSON<Partial<SvcFilterDefaults>>(SVC_FILTER_DEFAULTS_KEY);
  if (!defaults || !Array.isArray(defaults.prunedServices)) return null;
  const traceServiceSet = new Set(sortedServiceNames);
  const pruned = new Set(defaults.prunedServices.filter(name => traceServiceSet.has(name)));
  if (pruned.size === 0 || pruned.size >= sortedServiceNames.length) return null;
  return treeMode === 'remove' ? sanitizePrunedServices(pruned, rootServiceNames) : pruned;
}

/**
 * Resolves the span filter for a trace from the URL.
 * The service hide set comes from svcFilter in the URL, else from the saved default; the other
 * clauses come from the repeated `f` parameter and apply in either case. svcFilter is the only
 * carrier of the hide set on service, because it is what the popover writes and what root protection
 * sanitizes, so a hide clause on service inside `f` is ignored. The tree mode comes from
 * `tree=lift`. Root protection applies in remove mode only, where hiding every root empties the
 * tree; in lift mode a hidden root's children become roots. The view default applies while the
 * URL carries none of `f`, `tree` and `svcFilter`, so that an existing link renders as it did
 * before the view had a default; a URL that carries an empty `f` is an explicit empty filter,
 * which is how clearing the view default is written back. Returns the filter and, if the
 * svcFilter parameter was stale or sanitized, the cleaned params to navigate to.
 */
export function resolveInitialFilter(
  search: string,
  sortedServiceNames: string[],
  rootServiceNames: Set<string>,
  skipSavedDefault = false,
  viewDefault: ISpanFilter | null = null
): { filter: ISpanFilter; cleanSearch?: string } {
  const params = queryString.parse(search);
  const svcFilterParam = typeof params.svcFilter === 'string' ? params.svcFilter : null;
  let filter: ISpanFilter;
  if (!urlSpeaks(params) && viewDefault) {
    filter = viewDefault;
  } else {
    const clauses = paramValues(params[CLAUSE_PARAM])
      .map(decodeClause)
      .filter((c): c is IClause => c !== null && !isServiceHideClause(c));
    const treeMode: TreeMode = params[TREE_PARAM] === LIFT_VALUE ? 'lift' : 'remove';
    filter = normalizeFilter({ clauses, treeMode });
  }
  const { treeMode } = filter;
  let cleanSearch: string | undefined;
  // A cleanup that removes svcFilter must leave the URL speaking, or a view default, also one of
  // a view selected after the cleanup, would replace the all-visible fallback on the next render.
  const cleanedSearch = (nextParams: queryString.ParsedQuery) => {
    if (!urlSpeaks(nextParams)) nextParams[CLAUSE_PARAM] = '';
    const cleaned = queryString.stringify(nextParams);
    return cleaned ? `?${cleaned}` : '';
  };

  if (svcFilterParam) {
    const decoded = decodeSvcFilter(sortedServiceNames, svcFilterParam);
    if (decoded && !decoded.stale) {
      const pruned = new Set<string>();
      for (const name of sortedServiceNames) {
        if (!decoded.visibleServices.has(name)) pruned.add(name);
      }
      const sanitized = treeMode === 'remove' ? sanitizePrunedServices(pruned, rootServiceNames) : pruned;
      filter = normalizeFilter(withHiddenServices(filter, sanitized));
      // If sanitization changed the filter, normalize svcFilter in the URL.
      if (!setsEqual(sanitized, pruned)) {
        const nextParams = { ...params };
        if (sanitized.size === 0) {
          delete nextParams.svcFilter;
        } else {
          const visible = new Set(sortedServiceNames.filter(n => !sanitized.has(n)));
          nextParams.svcFilter = encodeSvcFilter(sortedServiceNames, visible);
        }
        cleanSearch = cleanedSearch(nextParams);
      }
    } else {
      // Stale or invalid: discard the service filter and show all services.
      // Don't fall through to the saved default — the user opened a shared link
      // that no longer applies, so all-visible is the safest default.
      const nextParams = { ...params };
      delete nextParams.svcFilter;
      cleanSearch = cleanedSearch(nextParams);
    }
    return { filter, cleanSearch };
  }

  if (skipSavedDefault) return { filter };
  const saved = readDefaultServices(sortedServiceNames, rootServiceNames, treeMode);
  return { filter: saved ? normalizeFilter(withHiddenServices(filter, saved)) : filter };
}

/**
 * Builds the updated search string after a filter change. The hide clause on service is written
 * as svcFilter, every other clause as a repeated `f` parameter, and lift mode as `tree=lift`.
 * Under a view default, or when the URL already states the filter through any parameter, an empty
 * clause list is written as an empty `f`, so that a view default does not come back on a later
 * render. Returns the new search string (with leading '?' if non-empty, or '').
 */
export function buildFilterSearch(
  currentSearch: string,
  sortedServiceNames: string[],
  filter: ISpanFilter,
  viewDefault: ISpanFilter | null = null
): string {
  const params = queryString.parse(currentSearch);
  const spoke = urlSpeaks(params);
  const pruned = hiddenServices(filter);
  const encodedServices = encodeSvcFilter(
    sortedServiceNames,
    new Set(sortedServiceNames.filter(name => !pruned.has(name)))
  );
  if (encodedServices) {
    params.svcFilter = encodedServices;
  } else {
    delete params.svcFilter;
  }
  const others = filter.clauses.filter(c => !isServiceHideClause(c)).map(encodeClause);
  if (others.length) {
    params[CLAUSE_PARAM] = others;
  } else if (viewDefault || spoke) {
    params[CLAUSE_PARAM] = '';
  } else {
    delete params[CLAUSE_PARAM];
  }
  if (filter.treeMode === 'lift') {
    params[TREE_PARAM] = LIFT_VALUE;
  } else {
    delete params[TREE_PARAM];
  }
  const search = queryString.stringify(params);
  return search ? `?${search}` : '';
}

// The merged config always carries the default, so the fallback only narrows the type.
const DEFAULT_APPLY_THRESHOLD = defaultConfig.traceTimeline?.filterApplyThreshold ?? 10_000;
const NO_SERVICES: IOtelTrace['services'] = [];
const NO_SPANS: IOtelTrace['rootSpans'] = [];

type ApplyOptions = {
  // Save the service selection as the default for future traces.
  saveAsDefault?: boolean;
  // Remove the search text from the URL in the same navigation, for the text-to-chip conversion.
  clearUiFind?: boolean;
};

type UseSpanFilterResult = {
  spanFilter: ISpanFilter;
  applyFilter: (filter: ISpanFilter, options?: ApplyOptions) => void;
  // The funnel button with its popover, rendered once in the header cluster and once in the
  // timeline column header; the two instances edit the same filter.
  spanFilterNode: React.ReactNode;
};

/**
 * Owns the span filter of the trace page: it resolves the filter from the URL, the saved default
 * and the view default, writes changes back to the URL, deselects a side panel span that a change
 * hides, and renders the funnel button. The trace is null while the page is loading, and then the
 * hook does nothing. The view default is the filter a view applies while the URL is silent, such
 * as the GenAI view's hide clause on the Non-GenAI span type; null for a view without one.
 */
export function useSpanFilter(
  trace: IOtelTrace | TNil,
  detailPanelMode: SpanDetailPanelMode,
  viewDefault: ISpanFilter | null = null
): UseSpanFilterResult {
  const location = useLocation();
  const navigate = useNavigate();
  const services = trace?.services ?? NO_SERVICES;
  const rootSpans = trace?.rootSpans ?? NO_SPANS;
  const sortedServiceNames = useMemo(() => getSortedServiceNames(services), [services]);
  const rootServiceNames = useMemo(() => {
    const names = new Set<string>();
    for (const span of rootSpans) {
      names.add(span.resource.serviceName);
    }
    return names;
  }, [rootSpans]);
  const applyThreshold = useConfig().traceTimeline?.filterApplyThreshold ?? DEFAULT_APPLY_THRESHOLD;

  const spanFilter = useTraceTimelineStore(s => s.spanFilter);
  const setSpanFilter = useTraceTimelineStore(s => s.setSpanFilter);
  const hiddenIDs = useMemo(
    () => evaluateSpanFilter(trace?.spans, spanFilter).hiddenIDs,
    [trace?.spans, spanFilter]
  );

  // The search string the hook last navigated to, after an edit or a URL cleanup. The resolve
  // effect treats a run for that search as a run for the selection the user has, so the saved
  // default does not come back on it. A string rather than a flag survives a re-run for the old URL
  // that lands between the navigation and its commit, which React batches with a view switch.
  const writtenSearch = useRef<string | null>(null);

  // The side panel shows one selected span, and a filter that hides it deselects it, whether the
  // filter came from a control, the URL or a view default. The trace and the panel mode are read
  // through a ref so that a change to either does not re-run the resolve effect below.
  const latest = useRef({ trace, detailPanelMode });
  latest.current = { trace, detailPanelMode };
  const deselectHidden = useCallback((filter: ISpanFilter) => {
    const { trace: current, detailPanelMode: mode } = latest.current;
    if (!current || mode !== 'sidepanel') return;
    const currentSelectedID = getSelectedSpanID(useTraceTimelineStore.getState().detailStates);
    if (currentSelectedID && evaluateSpanFilter(current.spans, filter).hiddenIDs.has(currentSelectedID)) {
      // In sidepanel mode detailStates holds at most one entry (the selected span).
      // The Map shape is a leftover from inline mode where multiple spans can be
      // expanded simultaneously. Clearing the whole map is correct here.
      useTraceTimelineStore.setState({ detailStates: new Map() });
    }
  }, []);

  // Resolve the filter from the URL, the saved default or the view default whenever relevant
  // inputs change (trace identity, URL search string, view). Guards against loops by comparing
  // the resolved filter to the current state before writing.
  // The URL cannot say that no service is hidden, so a re-run for the same URL and trace, such as
  // a view switch or a refetch, keeps the service selection the user has edited instead of reading
  // the saved default again. Before the user edits anything, a re-run resolves afresh, so that the
  // saved default applies under the tree mode of the view the page settles on.
  const lastResolved = useRef<{ search: string; key: string; traceID: string; edited: boolean } | null>(null);
  const traceID = trace?.traceID;
  useEffect(() => {
    if (!traceID) return;
    // The edit survives a URL change only when the hook wrote that URL itself; a run for a URL that
    // came from elsewhere re-reads the saved default and starts over.
    const last = lastResolved.current;
    const sameTrace = last?.traceID === traceID;
    const written = writtenSearch.current === location.search;
    if (writtenSearch.current !== null && !written) {
      // A navigation is pending. A run for the location already resolved, with the same key, is the
      // stale render before that navigation commits, and resolving it would overwrite the filter the
      // user just applied. A run for any other location, including one that restored the same search
      // under a new key, means another navigation won, so the pending one is forgotten.
      if (sameTrace && last.search === location.search && last.key === location.key) return;
      writtenSearch.current = null;
    }
    if (written) writtenSearch.current = null;
    const skip = sameTrace && last.edited && (last.search === location.search || written);
    lastResolved.current = { search: location.search, key: location.key, traceID, edited: skip };

    const current = useTraceTimelineStore.getState().spanFilter;
    // Every hidden service the user keeps is in the URL as svcFilter, so a re-run for the same
    // inputs skips the saved default and gets the selection the user has.
    const resolve = (view: ISpanFilter | null, skipSaved: boolean) =>
      resolveInitialFilter(location.search, sortedServiceNames, rootServiceNames, skipSaved, view);
    const spans = latest.current.trace?.spans;
    const leavesNothing = (f: ISpanFilter) =>
      Boolean(spans?.length) && evaluateSpanFilter(spans!, f).hiddenIDs.size >= spans!.length;
    let { filter, cleanSearch } = resolve(viewDefault, skip);
    // A default that would leave no span is not applied: first the view default goes, then the
    // saved service default. The check walks the trace, so it runs only when a default applied.
    const params = queryString.parse(location.search);
    const viewApplied = viewDefault !== null && !urlSpeaks(params);
    if (viewApplied && leavesNothing(filter)) ({ filter, cleanSearch } = resolve(null, skip));
    // A URL that sets the services leaves no saved default to drop; the test only saves the walk.
    const urlSetsServices = typeof params.svcFilter === 'string' && params.svcFilter !== '';
    const savedApplied = !skip && !urlSetsServices && hiddenServices(filter).size > 0;
    if (savedApplied && leavesNothing(filter)) {
      // The saved default is dropped only when it is the cause; a URL that leaves no span by itself
      // keeps it, so the popover still shows the services the user saved.
      const without = resolve(viewDefault, true);
      if (!leavesNothing(without.filter)) ({ filter, cleanSearch } = without);
    }
    // Avoid unnecessary Zustand writes (and re-renders) when the resolved filter matches.
    if (!spanFiltersEqual(current, filter)) {
      setSpanFilter(filter);
      deselectHidden(filter);
    }
    if (cleanSearch != null && cleanSearch !== location.search) {
      // The cleanup discards the saved default like an edit does, so a later re-resolve for the
      // cleaned URL does not bring it back.
      writtenSearch.current = cleanSearch;
      lastResolved.current.edited = true;
      navigate(
        { pathname: location.pathname, search: cleanSearch },
        { replace: true, state: location.state }
      );
    }
  }, [
    deselectHidden,
    location.key,
    location.pathname,
    location.search,
    location.state,
    navigate,
    rootServiceNames,
    sortedServiceNames,
    traceID,
    setSpanFilter,
    viewDefault,
  ]);

  const applyFilter = useCallback(
    (requested: ISpanFilter, options: ApplyOptions = {}) => {
      if (!trace) return;
      if (lastResolved.current) lastResolved.current.edited = true;
      // Enforce root service protection in remove mode even if the UI somehow allows it.
      const requestedServices = hiddenServices(requested);
      const nextPruned =
        requested.treeMode === 'remove'
          ? sanitizePrunedServices(requestedServices, rootServiceNames)
          : requestedServices;
      const nextFilter = normalizeFilter(withHiddenServices(requested, nextPruned));
      setSpanFilter(nextFilter);
      if (options.saveAsDefault) {
        const defaults: SvcFilterDefaults = { prunedServices: [...nextPruned] };
        storage.set(SVC_FILTER_DEFAULTS_KEY, defaults);
      }

      deselectHidden(nextFilter);

      let search = buildFilterSearch(location.search, sortedServiceNames, nextFilter, viewDefault);
      if (options.clearUiFind) {
        const params = queryString.parse(search);
        delete params.uiFind;
        const cleaned = queryString.stringify(params);
        search = cleaned ? `?${cleaned}` : '';
      }
      // The navigation re-runs the resolve effect when it changes the URL. The user just chose this
      // filter, so the saved default must not come back on that run when the selection is empty.
      // An unchanged URL runs no effect, so nothing is pending for it, and a value left over from an
      // edit that a later edit undid before its navigation committed is dropped.
      writtenSearch.current = search !== location.search ? search : null;
      navigate({ pathname: location.pathname, search }, { replace: true, state: location.state });
    },
    [
      setSpanFilter,
      deselectHidden,
      rootServiceNames,
      trace,
      location.pathname,
      location.search,
      location.state,
      sortedServiceNames,
      navigate,
      viewDefault,
    ]
  );

  const spanFilterNode = useMemo(
    () =>
      trace ? (
        <SpanFilterButton
          key={trace.traceID}
          trace={trace}
          filter={spanFilter}
          hiddenCount={hiddenIDs.size}
          onChange={applyFilter}
          applyThreshold={applyThreshold}
        />
      ) : null,
    [trace, spanFilter, hiddenIDs.size, applyFilter, applyThreshold]
  );

  return { spanFilter, applyFilter, spanFilterNode };
}
