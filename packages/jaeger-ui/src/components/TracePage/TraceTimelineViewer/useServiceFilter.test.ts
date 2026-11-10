// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { renderHook } from '@testing-library/react';

const mockNavigate = vi.fn();
const mockSetSpanFilter = vi.fn();
const mockStoreState = {
  spanFilter: EMPTY_SPAN_FILTER as ISpanFilter,
  setSpanFilter: mockSetSpanFilter,
  detailStates: new Map(),
};

vi.mock('react-router-dom', () => ({
  useLocation: vi.fn(() => ({ search: '', pathname: '/trace/abc' })),
  useNavigate: vi.fn(() => mockNavigate),
}));

vi.mock('./store', () => ({
  useTraceTimelineStore: Object.assign(
    vi.fn((selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState)),
    {
      getState: () => mockStoreState,
      setState: vi.fn((partial: Partial<typeof mockStoreState>) => Object.assign(mockStoreState, partial)),
    }
  ),
  getSelectedSpanID: (detailStates: Map<string, unknown>) =>
    detailStates.size > 0 ? (detailStates.keys().next().value as string) : null,
}));

vi.mock('./generateRowStates', async importOriginal => {
  const actual = await importOriginal<typeof import('./generateRowStates')>();
  return actual;
});

type OnChange = (filter: ISpanFilter, options?: { saveAsDefault?: boolean; clearUiFind?: boolean }) => void;
let capturedOnChange: OnChange | null = null;
let capturedApplyThreshold: number | null = null;
vi.mock('./ServiceFilter', () => ({
  default: (props: { onChange: OnChange; applyThreshold: number }) => {
    capturedOnChange = props.onChange;
    capturedApplyThreshold = props.applyThreshold;
    return null;
  },
}));

const { mockConfig } = vi.hoisted(() => ({ mockConfig: { current: {} as Record<string, unknown> } }));
vi.mock('../../../hooks/useConfig', () => ({ useConfig: () => mockConfig.current }));

vi.mock('../url/svcFilter', async importOriginal => {
  const actual = await importOriginal<typeof import('../url/svcFilter')>();
  return {
    ...actual,
    decodeSvcFilter: vi.fn(() => null),
    encodeSvcFilter: vi.fn(() => null),
    getSortedServiceNames: vi.fn((services: Array<{ name: string }>) => services.map(s => s.name).sort()),
  };
});

import { useLocation } from 'react-router-dom';
import { useTraceTimelineStore } from './store';
import { decodeSvcFilter, encodeSvcFilter } from '../url/svcFilter';
import { resolveInitialFilter, buildFilterSearch, useSpanFilter } from './useServiceFilter';
import {
  EMPTY_SPAN_FILTER,
  GENAI_VIEW_FILTER,
  hiddenServices,
  IClause,
  ISpanFilter,
  normalizeFilter,
  spanFiltersEqual,
  withHiddenServices,
} from '../spanFilter';
import { IOtelSpan, IOtelTrace } from '../../../types/otel';

const serviceFilter = (...services: string[]): ISpanFilter =>
  withHiddenServices(EMPTY_SPAN_FILTER, new Set(services));

describe('resolveInitialFilter', () => {
  const roots = new Set(['svc-a']);

  beforeEach(() => {
    vi.mocked(decodeSvcFilter).mockReturnValue(null);
    localStorage.clear();
  });

  it('returns empty pruned set when no svcFilter in URL and no localStorage', () => {
    const result = resolveInitialFilter('', ['svc-a', 'svc-b'], roots);
    expect(hiddenServices(result.filter).size).toBe(0);
    expect(result.cleanSearch).toBeUndefined();
  });

  it('decodes svcFilter from URL when valid', () => {
    vi.mocked(decodeSvcFilter).mockReturnValue({
      visibleServices: new Set(['svc-a']),
      stale: false,
    });
    const result = resolveInitialFilter('?svcFilter=abc.1', ['svc-a', 'svc-b'], roots);
    expect(hiddenServices(result.filter)).toEqual(new Set(['svc-b']));
    expect(result.cleanSearch).toBeUndefined();
  });

  it('discards stale svcFilter and returns all-visible (ignores localStorage)', () => {
    vi.mocked(decodeSvcFilter).mockReturnValue({ visibleServices: new Set(), stale: true });
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    const result = resolveInitialFilter('?svcFilter=stale.ff&uiFind=foo', ['svc-a', 'svc-b', 'svc-c'], roots);
    expect(hiddenServices(result.filter).size).toBe(0);
    expect(result.cleanSearch).toBe('?f=&uiFind=foo');
  });

  it('writes an explicit empty filter when stale svcFilter is the only param', () => {
    vi.mocked(decodeSvcFilter).mockReturnValue({ visibleServices: new Set(), stale: true });
    const result = resolveInitialFilter('?svcFilter=stale.ff', ['svc-a'], roots);
    expect(hiddenServices(result.filter).size).toBe(0);
    expect(result.cleanSearch).toBe('?f=');
  });

  it('reads localStorage defaults when no svcFilter in URL', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    const result = resolveInitialFilter('', ['svc-a', 'svc-b', 'svc-c'], roots);
    expect(hiddenServices(result.filter)).toEqual(new Set(['svc-b']));
  });

  it('ignores localStorage defaults that prune unknown services', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['unknown'] }));
    const result = resolveInitialFilter('', ['svc-a', 'svc-b'], roots);
    expect(hiddenServices(result.filter).size).toBe(0);
  });

  it('ignores localStorage defaults that would prune all services', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-a', 'svc-b'] }));
    const result = resolveInitialFilter('', ['svc-a', 'svc-b'], roots);
    expect(hiddenServices(result.filter).size).toBe(0);
  });

  it('ignores malformed localStorage', () => {
    localStorage.setItem('svcFilter.defaults', 'not-json');
    const result = resolveInitialFilter('', ['svc-a'], roots);
    expect(hiddenServices(result.filter).size).toBe(0);
  });

  it('reads f clauses from the URL', () => {
    const result = resolveInitialFilter('?f=k%3Astatus%3Aerror&f=h%3Atext%3Afoo', ['svc-a'], roots);
    expect(result.filter).toEqual({
      clauses: [
        { verb: 'keep', criterion: { shape: 'set', property: 'status', values: ['error'] } },
        { verb: 'hide', criterion: { shape: 'text', text: 'foo' } },
      ],
      treeMode: 'remove',
    });
    expect(result.cleanSearch).toBeUndefined();
  });

  it('keeps one copy of a clause the URL repeats', () => {
    const result = resolveInitialFilter('?f=h%3Atext%3Afoo&f=h%3Atext%3Afoo', ['svc-a'], roots);
    expect(result.filter.clauses).toEqual([{ verb: 'hide', criterion: { shape: 'text', text: 'foo' } }]);
  });

  it('drops a malformed f clause and keeps the rest', () => {
    const result = resolveInitialFilter('?f=nonsense&f=k%3Astatus%3Aerror', ['svc-a'], roots);
    expect(result.filter.clauses).toEqual([
      { verb: 'keep', criterion: { shape: 'set', property: 'status', values: ['error'] } },
    ]);
  });

  it('combines svcFilter with f clauses', () => {
    vi.mocked(decodeSvcFilter).mockReturnValue({ visibleServices: new Set(['svc-a']), stale: false });
    const result = resolveInitialFilter('?svcFilter=abc.1&f=k%3Astatus%3Aerror', ['svc-a', 'svc-b'], roots);
    expect(result.filter.clauses).toEqual([
      { verb: 'hide', criterion: { shape: 'set', property: 'service', values: ['svc-b'] } },
      { verb: 'keep', criterion: { shape: 'set', property: 'status', values: ['error'] } },
    ]);
    expect(result.cleanSearch).toBeUndefined();
  });

  it('ignores a hide clause on service in f, which only svcFilter carries', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    const result = resolveInitialFilter('?f=h%3Aservice%3Asvc-a', ['svc-a', 'svc-b', 'svc-c'], roots);
    expect(result.filter).toEqual(serviceFilter('svc-b'));
    expect(result.cleanSearch).toBeUndefined();
  });

  it('applies the saved default next to the f clauses when the URL has no svcFilter', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    const result = resolveInitialFilter('?f=k%3Astatus%3Aerror', ['svc-a', 'svc-b', 'svc-c'], roots);
    expect(result.filter.clauses).toEqual([
      { verb: 'hide', criterion: { shape: 'set', property: 'service', values: ['svc-b'] } },
      { verb: 'keep', criterion: { shape: 'set', property: 'status', values: ['error'] } },
    ]);
  });

  it('reads lift mode from tree=lift and skips root protection in it', () => {
    vi.mocked(decodeSvcFilter).mockReturnValue({ visibleServices: new Set(['svc-b']), stale: false });
    const result = resolveInitialFilter('?svcFilter=abc.1&tree=lift', ['svc-a', 'svc-b'], roots);
    expect(result.filter).toEqual(
      withHiddenServices({ ...EMPTY_SPAN_FILTER, treeMode: 'lift' }, new Set(['svc-a']))
    );
    expect(result.cleanSearch).toBeUndefined();
  });

  it('reads lift mode from tree=lift alone and applies the saved default next to it', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    const result = resolveInitialFilter('?tree=lift', ['svc-a', 'svc-b', 'svc-c'], roots);
    expect(result.filter).toEqual(
      withHiddenServices({ ...EMPTY_SPAN_FILTER, treeMode: 'lift' }, new Set(['svc-b']))
    );
  });

  it('applies a saved default that hides the sole root in lift mode but not in remove mode', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-a'] }));
    expect(hiddenServices(resolveInitialFilter('?tree=lift', ['svc-a', 'svc-b'], roots).filter)).toEqual(
      new Set(['svc-a'])
    );
    expect(hiddenServices(resolveInitialFilter('', ['svc-a', 'svc-b'], roots).filter).size).toBe(0);
  });

  it('falls through to the saved default when every f value is malformed', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    const result = resolveInitialFilter('?f=garbage&f=', ['svc-a', 'svc-b', 'svc-c'], roots);
    expect(result.filter).toEqual(serviceFilter('svc-b'));
  });

  it('falls through to the saved default when svcFilter is empty', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    const result = resolveInitialFilter('?svcFilter=', ['svc-a', 'svc-b', 'svc-c'], roots);
    expect(hiddenServices(result.filter)).toEqual(new Set(['svc-b']));
  });

  describe('view default', () => {
    const svcDefault = { prunedServices: ['svc-b'] };

    it('applies the view default while the URL carries none of f, tree and svcFilter', () => {
      const { filter } = resolveInitialFilter(
        '?uiFind=x',
        ['svc-a', 'svc-b'],
        roots,
        false,
        GENAI_VIEW_FILTER
      );
      expect(filter).toEqual(GENAI_VIEW_FILTER);
    });

    it('lets an explicitly empty f clear the view default', () => {
      const { filter } = resolveInitialFilter('?f=', ['svc-a', 'svc-b'], roots, false, GENAI_VIEW_FILTER);
      expect(filter).toEqual(EMPTY_SPAN_FILTER);
    });

    it('lets tree alone override the view default', () => {
      const { filter } = resolveInitialFilter(
        '?tree=lift',
        ['svc-a', 'svc-b'],
        roots,
        false,
        GENAI_VIEW_FILTER
      );
      expect(filter).toEqual({ ...EMPTY_SPAN_FILTER, treeMode: 'lift' });
    });

    it('merges the saved service default with the view default', () => {
      localStorage.setItem('svcFilter.defaults', JSON.stringify(svcDefault));
      const saved = resolveInitialFilter('', ['svc-a', 'svc-b'], roots, false, GENAI_VIEW_FILTER);
      expect(saved.filter).toEqual(
        normalizeFilter(withHiddenServices(GENAI_VIEW_FILTER, new Set(['svc-b'])))
      );
    });

    it('keeps the URL speaking when a cleanup removes svcFilter, before or under a view default', () => {
      vi.mocked(decodeSvcFilter).mockReturnValue({ visibleServices: new Set(), stale: true });
      const stale = resolveInitialFilter('?svcFilter=stale.ff', ['svc-a'], roots, false, GENAI_VIEW_FILTER);
      expect(stale).toEqual({ filter: EMPTY_SPAN_FILTER, cleanSearch: '?f=' });
      // The page opens in the plain view and selects the GenAI view after the cleanup.
      expect(resolveInitialFilter('?svcFilter=stale.ff', ['svc-a'], roots).cleanSearch).toBe('?f=');
      // A tree parameter already keeps the URL speaking, so the cleanup adds no f.
      expect(resolveInitialFilter('?svcFilter=stale.ff&tree=lift', ['svc-a'], roots).cleanSearch).toBe(
        '?tree=lift'
      );
      expect(
        resolveInitialFilter('?svcFilter=stale.ff&uiFind=x', ['svc-a'], roots, false, GENAI_VIEW_FILTER)
          .cleanSearch
      ).toBe('?f=&uiFind=x');
      // Hiding every root in remove mode is sanitized to no hidden service.
      vi.mocked(decodeSvcFilter).mockReturnValue({ visibleServices: new Set(['svc-b']), stale: false });
      const sanitized = resolveInitialFilter(
        '?svcFilter=abc.2',
        ['svc-a', 'svc-b'],
        new Set(['svc-a']),
        false,
        GENAI_VIEW_FILTER
      );
      expect(sanitized).toEqual({ filter: EMPTY_SPAN_FILTER, cleanSearch: '?f=' });
      expect(
        resolveInitialFilter('?f=', ['svc-a'], new Set(['svc-a']), true, GENAI_VIEW_FILTER).filter
      ).toEqual(EMPTY_SPAN_FILTER);
    });

    it('renders a svcFilter link as before the view had a default', () => {
      vi.mocked(decodeSvcFilter).mockReturnValue({ visibleServices: new Set(['svc-a']), stale: false });
      const url = resolveInitialFilter(
        '?svcFilter=abc.1',
        ['svc-a', 'svc-b'],
        roots,
        false,
        GENAI_VIEW_FILTER
      );
      expect(url.filter).toEqual(withHiddenServices(EMPTY_SPAN_FILTER, new Set(['svc-b'])));
      vi.mocked(decodeSvcFilter).mockReturnValue(null);
      const bare = resolveInitialFilter('?svcFilter', ['svc-a', 'svc-b'], roots, false, GENAI_VIEW_FILTER);
      expect(bare.filter).toEqual(EMPTY_SPAN_FILTER);
    });
  });

  describe('root service sanitization', () => {
    it('removes sole root service from pruned set and cleans URL when filter becomes empty', () => {
      vi.mocked(decodeSvcFilter).mockReturnValue({
        visibleServices: new Set(['svc-b']),
        stale: false,
      });
      // URL tries to prune only svc-a (the sole root) — sanitization empties the filter
      const result = resolveInitialFilter('?svcFilter=abc.2', ['svc-a', 'svc-b'], new Set(['svc-a']));
      expect(hiddenServices(result.filter).has('svc-a')).toBe(false);
      expect(hiddenServices(result.filter).size).toBe(0);
      expect(result.cleanSearch).toBe('?f=');
    });

    it('removes sole root service but keeps other pruned services and normalizes URL', () => {
      vi.mocked(decodeSvcFilter).mockReturnValue({
        visibleServices: new Set(['svc-c']),
        stale: false,
      });
      // URL prunes svc-a (root) and svc-b — sanitization keeps svc-b pruned
      // and normalizes the URL since the filter changed
      const result = resolveInitialFilter(
        '?svcFilter=abc.4',
        ['svc-a', 'svc-b', 'svc-c'],
        new Set(['svc-a'])
      );
      expect(hiddenServices(result.filter).has('svc-a')).toBe(false);
      expect(hiddenServices(result.filter)).toEqual(new Set(['svc-b']));
      expect(result.cleanSearch).toBeDefined();
    });

    it('removes sole root service from pruned set (localStorage)', () => {
      localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-a', 'svc-b'] }));
      const result = resolveInitialFilter('', ['svc-a', 'svc-b', 'svc-c'], new Set(['svc-a']));
      expect(hiddenServices(result.filter).has('svc-a')).toBe(false);
      expect(hiddenServices(result.filter).has('svc-b')).toBe(true);
    });

    it('discards filter and cleans URL when all root services would be pruned (multi-root)', () => {
      vi.mocked(decodeSvcFilter).mockReturnValue({
        visibleServices: new Set(['svc-c']),
        stale: false,
      });
      // Both roots pruned — sanitization empties the filter, URL should be cleaned
      const result = resolveInitialFilter(
        '?svcFilter=abc.4',
        ['svc-a', 'svc-b', 'svc-c'],
        new Set(['svc-a', 'svc-b'])
      );
      expect(hiddenServices(result.filter).size).toBe(0);
      expect(result.cleanSearch).toBe('?f=');
    });

    it('keeps filter when at least one root service is visible (multi-root)', () => {
      vi.mocked(decodeSvcFilter).mockReturnValue({
        visibleServices: new Set(['svc-a', 'svc-c']),
        stale: false,
      });
      // svc-b (a root) is pruned but svc-a (also a root) is visible
      const result = resolveInitialFilter(
        '?svcFilter=abc.5',
        ['svc-a', 'svc-b', 'svc-c'],
        new Set(['svc-a', 'svc-b'])
      );
      expect(hiddenServices(result.filter)).toEqual(new Set(['svc-b']));
    });
  });
});

describe('buildFilterSearch', () => {
  beforeEach(() => {
    vi.mocked(encodeSvcFilter).mockReturnValue(null);
  });

  it('replaces svcFilter with an explicit empty filter when no services are pruned', () => {
    const search = buildFilterSearch('?svcFilter=old.1&uiFind=foo', ['svc-a', 'svc-b'], EMPTY_SPAN_FILTER);
    expect(search).toBe('?f=&uiFind=foo');
  });

  it('keeps the URL speaking when clearing the only filter param', () => {
    const search = buildFilterSearch('?svcFilter=old.1', ['svc-a'], EMPTY_SPAN_FILTER);
    expect(search).toBe('?f=');
    expect(buildFilterSearch('', ['svc-a'], EMPTY_SPAN_FILTER)).toBe('');
  });

  it('sets svcFilter when services are pruned', () => {
    vi.mocked(encodeSvcFilter).mockReturnValue('abc.1');
    const search = buildFilterSearch('', ['svc-a', 'svc-b'], serviceFilter('svc-b'));
    expect(search).toBe('?svcFilter=abc.1');
  });

  it('preserves existing URL params alongside svcFilter', () => {
    vi.mocked(encodeSvcFilter).mockReturnValue('abc.1');
    const search = buildFilterSearch('?uiFind=hello', ['svc-a', 'svc-b'], serviceFilter('svc-b'));
    expect(search).toContain('uiFind=hello');
    expect(search).toContain('svcFilter=abc.1');
  });

  it('writes every clause other than the service hide set as an f parameter', () => {
    const filter: ISpanFilter = {
      clauses: [
        { verb: 'keep', criterion: { shape: 'set', property: 'status', values: ['error'] } },
        { verb: 'hide', criterion: { shape: 'attr', text: 'http.method:GET' } },
      ],
      treeMode: 'remove',
    };
    const search = buildFilterSearch('?uiFind=x', ['svc-a'], filter);
    expect(search).toBe('?f=k%3Astatus%3Aerror&f=h%3Aattr%3Ahttp.method%3AGET&uiFind=x');
  });

  it('writes tree=lift for lift mode and removes it for remove mode', () => {
    expect(buildFilterSearch('?uiFind=x', ['svc-a'], { ...EMPTY_SPAN_FILTER, treeMode: 'lift' })).toBe(
      '?tree=lift&uiFind=x'
    );
    expect(buildFilterSearch('?tree=lift', ['svc-a'], EMPTY_SPAN_FILTER)).toBe('?f=');
  });

  it('writes a URL that resolves back to the same filter', () => {
    const filter: ISpanFilter = {
      clauses: [
        { verb: 'keep', criterion: { shape: 'set', property: 'kind', values: ['100%', 'a,b', 'c d'] } },
        { verb: 'hide', criterion: { shape: 'range', property: 'duration', min: 1_234_567, max: 2_000_000 } },
        { verb: 'hide', criterion: { shape: 'attr', text: 'http.method:GET' } },
      ],
      treeMode: 'remove',
    };
    const search = buildFilterSearch('', ['svc-a'], filter);
    const { filter: resolved } = resolveInitialFilter(search, ['svc-a'], new Set(['svc-a']));
    expect(resolved).toEqual(filter);
  });

  it('round-trips a service hide set next to f clauses through the real svcFilter codec', async () => {
    const actual = await vi.importActual<typeof import('../url/svcFilter')>('../url/svcFilter');
    vi.mocked(encodeSvcFilter).mockImplementation(actual.encodeSvcFilter);
    vi.mocked(decodeSvcFilter).mockImplementation(actual.decodeSvcFilter);
    try {
      const services = ['svc-a', 'svc-b', 'svc-c'];
      const filter = normalizeFilter(
        withHiddenServices(
          {
            clauses: [{ verb: 'keep', criterion: { shape: 'set', property: 'status', values: ['error'] } }],
            treeMode: 'remove',
          },
          new Set(['svc-c'])
        )
      );
      const search = buildFilterSearch('?uiFind=x', services, filter);
      expect(search).toMatch(/svcFilter=/);
      const { filter: resolved, cleanSearch } = resolveInitialFilter(search, services, new Set(['svc-a']));
      expect(cleanSearch).toBeUndefined();
      expect(spanFiltersEqual(resolved, filter)).toBe(true);
    } finally {
      vi.mocked(encodeSvcFilter).mockReturnValue(null);
      vi.mocked(decodeSvcFilter).mockReturnValue(null);
    }
  });

  it('writes an empty f under a view default so that the default does not come back', () => {
    expect(buildFilterSearch('?uiFind=x', ['svc-a'], EMPTY_SPAN_FILTER, GENAI_VIEW_FILTER)).toBe(
      '?f=&uiFind=x'
    );
    // A view without a default keeps the empty f it was given, so that a switch back to the view
    // with the default does not bring the default back.
    expect(buildFilterSearch('?f=', ['svc-a'], EMPTY_SPAN_FILTER)).toBe('?f=');
    expect(buildFilterSearch('?f=&tree=lift', ['svc-a'], EMPTY_SPAN_FILTER)).toBe('?f=');
    expect(buildFilterSearch('?tree=lift', ['svc-a'], EMPTY_SPAN_FILTER)).toBe('?f=');
    vi.mocked(encodeSvcFilter).mockReturnValueOnce(null);
    expect(buildFilterSearch('?svcFilter=abc.1', ['svc-a'], EMPTY_SPAN_FILTER)).toBe('?f=');
    expect(buildFilterSearch('?uiFind=x', ['svc-a'], EMPTY_SPAN_FILTER)).toBe('?uiFind=x');
    const written = buildFilterSearch('', ['svc-a'], GENAI_VIEW_FILTER, GENAI_VIEW_FILTER);
    expect(
      resolveInitialFilter(written, ['svc-a'], new Set(['svc-a']), false, GENAI_VIEW_FILTER).filter
    ).toEqual(GENAI_VIEW_FILTER);
  });

  it('removes svcFilter when encodeSvcFilter returns null', () => {
    vi.mocked(encodeSvcFilter).mockReturnValue(null);
    const search = buildFilterSearch('?svcFilter=old.1', ['svc-a'], serviceFilter('svc-a'));
    expect(search).toBe('?f=');
  });
});

describe('useSpanFilter hook', () => {
  function makeTrace(serviceNames: string[], rootServiceNames?: string[]): IOtelTrace {
    const services = serviceNames.map(name => ({ name, numberOfSpans: 3 }));
    const roots = rootServiceNames ?? [serviceNames[0]];
    const rootSpans = roots.map((name, i) => ({
      spanID: `root-${i}`,
      resource: { serviceName: name, attributes: [] },
    })) as unknown as IOtelSpan[];
    return {
      traceID: 'trace-1',
      services,
      rootSpans,
      spans: [],
      spanMap: new Map(),
    } as unknown as IOtelTrace;
  }

  beforeEach(() => {
    mockNavigate.mockClear();
    mockSetSpanFilter.mockClear();
    mockStoreState.spanFilter = EMPTY_SPAN_FILTER;
    mockStoreState.detailStates = new Map();
    capturedOnChange = null;
    vi.mocked(useLocation).mockReturnValue({ search: '', pathname: '/trace/abc' } as ReturnType<
      typeof useLocation
    >);
    vi.mocked(decodeSvcFilter).mockReturnValue(null);
    vi.mocked(encodeSvcFilter).mockReturnValue(null);
    (useTraceTimelineStore as unknown as { setState: ReturnType<typeof vi.fn> }).setState.mockClear();
    localStorage.clear();
  });

  it('hands the button the apply threshold from the UI configuration, with the default otherwise', () => {
    render(React.createElement(HookRenderer, { trace: makeTrace(['svc-a', 'svc-b']), mode: 'inline' }));
    expect(capturedApplyThreshold).toBe(10_000);
    mockConfig.current = { traceTimeline: { filterApplyThreshold: 5 } };
    try {
      render(React.createElement(HookRenderer, { trace: makeTrace(['svc-a', 'svc-b']), mode: 'inline' }));
      expect(capturedApplyThreshold).toBe(5);
    } finally {
      mockConfig.current = {};
    }
  });

  it('returns the filter and the button node', () => {
    const { result } = renderHook(() => useSpanFilter(makeTrace(['svc-a', 'svc-b']), 'inline'));
    expect(result.current.spanFilter).toEqual(EMPTY_SPAN_FILTER);
    expect(result.current.spanFilterNode).not.toBeNull();
  });

  it('does nothing while the trace is loading', () => {
    vi.mocked(useLocation).mockReturnValue({
      search: '?svcFilter=stale.ff',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    const { result } = renderHook(() => useSpanFilter(null, 'inline'));
    expect(result.current.spanFilterNode).toBeNull();
    expect(mockSetSpanFilter).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('skips setSpanFilter when the resolved filter equals the current state (no-op guard)', () => {
    // Store already has empty set; resolved is also empty → no write.
    renderHook(() => useSpanFilter(makeTrace(['svc-a', 'svc-b']), 'inline'));
    expect(mockSetSpanFilter).not.toHaveBeenCalled();
  });

  it('decodes svcFilter from URL on mount', () => {
    vi.mocked(useLocation).mockReturnValue({
      search: '?svcFilter=abc.1',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    vi.mocked(decodeSvcFilter).mockReturnValue({
      visibleServices: new Set(['svc-a']),
      stale: false,
    });
    renderHook(() => useSpanFilter(makeTrace(['svc-a', 'svc-b']), 'inline'));
    expect(mockSetSpanFilter).toHaveBeenCalledWith(serviceFilter('svc-b'));
  });

  it('navigates to clean URL when svcFilter is stale', () => {
    vi.mocked(useLocation).mockReturnValue({
      search: '?svcFilter=stale.ff',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    vi.mocked(decodeSvcFilter).mockReturnValue({ visibleServices: new Set(), stale: true });
    renderHook(() => useSpanFilter(makeTrace(['svc-a']), 'inline'));
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/trace/abc', search: '?f=' }),
      { replace: true }
    );
  });

  it('reads localStorage defaults when no URL svcFilter', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    renderHook(() => useSpanFilter(makeTrace(['svc-a', 'svc-b', 'svc-c']), 'inline'));
    expect(mockSetSpanFilter).toHaveBeenCalledWith(serviceFilter('svc-b'));
  });

  it('does not bring the saved default back when applying an empty selection rewrites the URL', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    const hideErrors: IClause = {
      verb: 'hide',
      criterion: { shape: 'set', property: 'status', values: ['error'] },
    };
    // A hand-written, unencoded f= value: the apply handler writes it back encoded, which changes
    // location.search and re-runs the resolve effect.
    vi.mocked(useLocation).mockReturnValue({
      search: '?f=h:status:error',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    // The store mock holds what the hook writes, as the real store does.
    mockSetSpanFilter.mockImplementation((filter: ISpanFilter) => {
      mockStoreState.spanFilter = filter;
    });
    const trace = makeTrace(['svc-a', 'svc-b', 'svc-c']);
    const { rerender } = render(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(
      normalizeFilter(withHiddenServices({ ...EMPTY_SPAN_FILTER, clauses: [hideErrors] }, new Set(['svc-b'])))
    );

    capturedOnChange!({ ...EMPTY_SPAN_FILTER, clauses: [hideErrors] });
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith({ ...EMPTY_SPAN_FILTER, clauses: [hideErrors] });
    const navigated = mockNavigate.mock.calls.at(-1)![0] as { search: string };
    expect(navigated.search).toBe('?f=h%3Astatus%3Aerror');

    vi.mocked(useLocation).mockReturnValue({
      search: navigated.search,
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith({ ...EMPTY_SPAN_FILTER, clauses: [hideErrors] });
    mockSetSpanFilter.mockImplementation(() => undefined);
  });

  it('applies the saved default to the next trace after an empty selection left the URL unchanged', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    mockSetSpanFilter.mockImplementation((filter: ISpanFilter) => {
      mockStoreState.spanFilter = filter;
    });
    const trace = makeTrace(['svc-a', 'svc-b', 'svc-c']);
    const { rerender } = render(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(serviceFilter('svc-b'));

    // The URL had no svcFilter and the empty selection writes none, so the resolve effect does
    // not run for this navigation.
    capturedOnChange!(EMPTY_SPAN_FILTER);
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(EMPTY_SPAN_FILTER);
    expect((mockNavigate.mock.calls.at(-1)![0] as { search: string }).search).toBe('');

    const next = { ...makeTrace(['svc-a', 'svc-b', 'svc-c']), traceID: 'trace-2' };
    rerender(React.createElement(HookRenderer, { trace: next, mode: 'inline' }));
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(serviceFilter('svc-b'));
    mockSetSpanFilter.mockImplementation(() => undefined);
  });

  function HookRenderer({
    trace,
    mode,
    viewDefault = null,
  }: {
    trace: IOtelTrace;
    mode: 'inline' | 'sidepanel';
    viewDefault?: ISpanFilter | null;
  }) {
    const { spanFilterNode } = useSpanFilter(trace, mode, viewDefault);
    return React.createElement('div', null, spanFilterNode);
  }

  it('clears selected span in sidepanel mode when its service is pruned via onApply', () => {
    const selectedSpanID = 'span-x';
    const selectedSpan = {
      spanID: selectedSpanID,
      resource: { serviceName: 'svc-b' },
      parentSpan: undefined,
    } as unknown as IOtelSpan;
    mockStoreState.detailStates = new Map([[selectedSpanID, {}]]) as typeof mockStoreState.detailStates;
    const trace = makeTrace(['svc-a', 'svc-b']);
    (trace as unknown as { spans: IOtelSpan[] }).spans = [selectedSpan];

    render(React.createElement(HookRenderer, { trace, mode: 'sidepanel' }));

    expect(capturedOnChange).not.toBeNull();
    capturedOnChange!(withHiddenServices(EMPTY_SPAN_FILTER, new Set(['svc-b'])));

    const storeSetState = (useTraceTimelineStore as unknown as { setState: ReturnType<typeof vi.fn> })
      .setState;
    expect(storeSetState).toHaveBeenCalledWith(expect.objectContaining({ detailStates: new Map() }));
  });

  it('clears the selected span in sidepanel mode when a view default hides it', () => {
    const selectedSpanID = 'span-x';
    const selectedSpan = {
      spanID: selectedSpanID,
      resource: { serviceName: 'svc-a' },
      parentSpan: undefined,
    } as unknown as IOtelSpan;
    mockStoreState.detailStates = new Map([[selectedSpanID, {}]]) as typeof mockStoreState.detailStates;
    const llm = {
      spanID: 'llm',
      resource: { serviceName: 'svc-a' },
      parentSpan: selectedSpan,
      genAIKind: 'LLM_CALL',
    } as unknown as IOtelSpan;
    const trace = makeTrace(['svc-a']);
    (trace as unknown as { spans: IOtelSpan[] }).spans = [selectedSpan, llm];
    const storeSetState = (useTraceTimelineStore as unknown as { setState: ReturnType<typeof vi.fn> })
      .setState;

    const { rerender } = render(React.createElement(HookRenderer, { trace, mode: 'sidepanel' }));
    expect(storeSetState).not.toHaveBeenCalledWith(expect.objectContaining({ detailStates: new Map() }));

    rerender(React.createElement(HookRenderer, { trace, mode: 'sidepanel', viewDefault: GENAI_VIEW_FILTER }));
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(GENAI_VIEW_FILTER);
    expect(storeSetState).toHaveBeenCalledWith(expect.objectContaining({ detailStates: new Map() }));
  });

  it('does not apply a saved default that would leave no span with the clauses the URL carries', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    vi.mocked(useLocation).mockReturnValue({
      search: '?f=h%3AspanType%3Anone&tree=lift',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    const trace = makeTrace(['svc-a', 'svc-b']);
    (trace as unknown as { spans: IOtelSpan[] }).spans = [
      { spanID: 'root', resource: { serviceName: 'svc-a' }, parentSpan: undefined },
      { spanID: 'llm', resource: { serviceName: 'svc-b' }, parentSpan: undefined, genAIKind: 'LLM_CALL' },
    ] as unknown as IOtelSpan[];
    render(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(GENAI_VIEW_FILTER);
  });

  it('does not apply a saved default that would leave no span when the URL carries an empty svcFilter', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    vi.mocked(useLocation).mockReturnValue({
      search: '?svcFilter=&f=h%3AspanType%3Anone&tree=lift',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    const trace = makeTrace(['svc-a', 'svc-b']);
    (trace as unknown as { spans: IOtelSpan[] }).spans = [
      { spanID: 'root', resource: { serviceName: 'svc-a' }, parentSpan: undefined },
      { spanID: 'llm', resource: { serviceName: 'svc-b' }, parentSpan: undefined, genAIKind: 'LLM_CALL' },
    ] as unknown as IOtelSpan[];
    render(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(GENAI_VIEW_FILTER);
  });

  it('does not apply a view default that would leave no span together with the saved default', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    const trace = makeTrace(['svc-a', 'svc-b']);
    (trace as unknown as { spans: IOtelSpan[] }).spans = [
      { spanID: 'root', resource: { serviceName: 'svc-a' }, parentSpan: undefined },
      { spanID: 'llm', resource: { serviceName: 'svc-b' }, parentSpan: undefined, genAIKind: 'LLM_CALL' },
    ] as unknown as IOtelSpan[];
    render(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(
      withHiddenServices(EMPTY_SPAN_FILTER, new Set(['svc-b']))
    );
  });

  it('re-reads the saved default under the view it settles on after a URL change that followed an edit', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-a', 'svc-b'] }));
    mockSetSpanFilter.mockImplementation((filter: ISpanFilter) => {
      mockStoreState.spanFilter = filter;
    });
    const trace = makeTrace(['svc-a', 'svc-b', 'svc-c']);
    (trace as unknown as { spans: IOtelSpan[] }).spans = [
      { spanID: 'root', resource: { serviceName: 'svc-a' }, parentSpan: undefined },
      { spanID: 'llm', resource: { serviceName: 'svc-c' }, parentSpan: undefined, genAIKind: 'LLM_CALL' },
    ] as unknown as IOtelSpan[];
    const { rerender } = render(
      React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER })
    );
    expect(mockStoreState.spanFilter).toEqual(
      normalizeFilter(withHiddenServices(GENAI_VIEW_FILTER, new Set(['svc-a', 'svc-b'])))
    );
    // The user shows both services; then the URL changes outside the filter, which re-reads the
    // saved default under lift mode, where hiding the root is allowed.
    capturedOnChange!(GENAI_VIEW_FILTER);
    vi.mocked(useLocation).mockReturnValue({
      search: '?f=h%3AspanType%3Anone&tree=lift',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    vi.mocked(useLocation).mockReturnValue({
      search: '?uiFind=x',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    expect(mockStoreState.spanFilter).toEqual(
      normalizeFilter(withHiddenServices(GENAI_VIEW_FILTER, new Set(['svc-a', 'svc-b'])))
    );
    // The plain view protects the root, so only svc-b stays hidden.
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: null }));
    expect(mockStoreState.spanFilter).toEqual(serviceFilter('svc-b'));
    mockSetSpanFilter.mockImplementation(() => undefined);
  });

  it('keeps an edited selection when a re-run for the old URL lands before the navigation commits', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    mockSetSpanFilter.mockImplementation((filter: ISpanFilter) => {
      mockStoreState.spanFilter = filter;
    });
    const trace = makeTrace(['svc-a', 'svc-b']);
    const { rerender } = render(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    expect(mockStoreState.spanFilter).toEqual(serviceFilter('svc-b'));
    // The user shows svc-b and hides the errors instead. React batches the navigation with a view
    // switch, so the effect runs once more for the old URL before it runs for the one the hook wrote.
    const errors: ISpanFilter = {
      ...EMPTY_SPAN_FILTER,
      clauses: [{ verb: 'hide', criterion: { property: 'status', shape: 'set', values: ['error'] } }],
    };
    capturedOnChange!(errors);
    const navigated = mockNavigate.mock.calls.at(-1)![0] as { search: string };
    expect(navigated.search).not.toBe('');
    const writes = mockSetSpanFilter.mock.calls.length;
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    // The stale run leaves the applied filter alone instead of resolving the old URL again.
    expect(mockSetSpanFilter.mock.calls.length).toBe(writes);
    expect(mockStoreState.spanFilter).toEqual(errors);
    vi.mocked(useLocation).mockReturnValue({
      search: navigated.search,
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    expect(mockStoreState.spanFilter).toEqual(errors);
    mockSetSpanFilter.mockImplementation(() => undefined);
  });

  it('forgets a pending navigation when a second edit returns the URL to its old value', () => {
    mockSetSpanFilter.mockImplementation((filter: ISpanFilter) => {
      mockStoreState.spanFilter = filter;
    });
    const trace = makeTrace(['svc-a']);
    (trace as unknown as { spans: IOtelSpan[] }).spans = [
      { spanID: 'root', resource: { serviceName: 'svc-a' }, parentSpan: undefined },
      { spanID: 'llm', resource: { serviceName: 'svc-a' }, parentSpan: undefined, genAIKind: 'LLM_CALL' },
    ] as unknown as IOtelSpan[];
    const { rerender } = render(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    // The user adds a chip and removes it again before the first navigation commits, so the URL
    // stays silent and no effect runs for either edit.
    capturedOnChange!({
      ...EMPTY_SPAN_FILTER,
      clauses: [{ verb: 'hide', criterion: { property: 'status', shape: 'set', values: ['error'] } }],
    });
    capturedOnChange!(EMPTY_SPAN_FILTER);
    expect((mockNavigate.mock.calls.at(-1)![0] as { search: string }).search).toBe('');
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    expect(mockStoreState.spanFilter).toEqual(GENAI_VIEW_FILTER);
    mockSetSpanFilter.mockImplementation(() => undefined);
  });

  it('resolves again after another navigation restores the old URL under a new key', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    mockSetSpanFilter.mockImplementation((filter: ISpanFilter) => {
      mockStoreState.spanFilter = filter;
    });
    vi.mocked(useLocation).mockReturnValue({
      search: '',
      pathname: '/trace/abc',
      key: 'first',
    } as ReturnType<typeof useLocation>);
    const trace = makeTrace(['svc-a', 'svc-b']);
    const { rerender } = render(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    expect(mockStoreState.spanFilter).toEqual(serviceFilter('svc-b'));
    const errors: ISpanFilter = {
      ...EMPTY_SPAN_FILTER,
      clauses: [{ verb: 'hide', criterion: { property: 'status', shape: 'set', values: ['error'] } }],
    };
    capturedOnChange!(errors);
    // Escape clears the search text and navigates to the same silent URL before the hook's own
    // navigation commits, so the hook's write is lost and the location gets a new key.
    vi.mocked(useLocation).mockReturnValue({
      search: '',
      pathname: '/trace/abc',
      key: 'second',
    } as ReturnType<typeof useLocation>);
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    expect(mockStoreState.spanFilter).toEqual(GENAI_VIEW_FILTER);
    mockSetSpanFilter.mockImplementation(() => undefined);
  });

  it('keeps the saved default when the URL clauses leave no span by themselves', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    vi.mocked(useLocation).mockReturnValue({
      search: '?f=k%3Astatus%3Aerror',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    const trace = makeTrace(['svc-a', 'svc-b']);
    (trace as unknown as { spans: IOtelSpan[] }).spans = [
      { spanID: 'root', resource: { serviceName: 'svc-a' }, parentSpan: undefined, status: { code: 0 } },
      { spanID: 'child', resource: { serviceName: 'svc-b' }, parentSpan: undefined, status: { code: 0 } },
    ] as unknown as IOtelSpan[];
    render(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    expect(hiddenServices(mockSetSpanFilter.mock.calls.at(-1)![0] as ISpanFilter)).toEqual(
      new Set(['svc-b'])
    );
  });

  it('re-reads the saved default when another navigation wins over the one the hook wrote', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    mockSetSpanFilter.mockImplementation((filter: ISpanFilter) => {
      mockStoreState.spanFilter = filter;
    });
    const trace = makeTrace(['svc-a', 'svc-b']);
    const { rerender } = render(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    expect(mockStoreState.spanFilter).toEqual(serviceFilter('svc-b'));
    capturedOnChange!({
      ...EMPTY_SPAN_FILTER,
      clauses: [{ verb: 'hide', criterion: { property: 'status', shape: 'set', values: ['error'] } }],
    });
    // A navigation from elsewhere lands instead of the one the hook wrote.
    vi.mocked(useLocation).mockReturnValue({
      search: '?uiFind=x',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    expect(mockStoreState.spanFilter).toEqual(serviceFilter('svc-b'));
    // The hook's navigation is no longer pending, so a view switch for the URL that won resolves.
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    expect(mockStoreState.spanFilter).toEqual(
      normalizeFilter(withHiddenServices(GENAI_VIEW_FILTER, new Set(['svc-b'])))
    );
    mockSetSpanFilter.mockImplementation(() => undefined);
  });

  it('does not bring the saved default back on a view switch after a stale svcFilter was cleaned', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    vi.mocked(decodeSvcFilter).mockReturnValue({ visibleServices: new Set(), stale: true });
    vi.mocked(useLocation).mockReturnValue({
      search: '?svcFilter=stale.ff',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    mockSetSpanFilter.mockImplementation((filter: ISpanFilter) => {
      mockStoreState.spanFilter = filter;
    });
    const trace = makeTrace(['svc-a', 'svc-b']);
    const { rerender } = render(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    const navigated = mockNavigate.mock.calls.at(-1)![0] as { search: string };
    expect(navigated.search).toBe('?f=');
    vi.mocked(useLocation).mockReturnValue({
      search: navigated.search,
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    expect(mockStoreState.spanFilter).toEqual(EMPTY_SPAN_FILTER);
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    expect(mockStoreState.spanFilter).toEqual(EMPTY_SPAN_FILTER);
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: null }));
    expect(mockStoreState.spanFilter).toEqual(EMPTY_SPAN_FILTER);
    mockSetSpanFilter.mockImplementation(() => undefined);
    vi.mocked(decodeSvcFilter).mockReturnValue(null);
  });

  it('keeps the saved default across a view switch when the URL carries an empty svcFilter', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    vi.mocked(useLocation).mockReturnValue({
      search: '?svcFilter=',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    mockSetSpanFilter.mockImplementation((filter: ISpanFilter) => {
      mockStoreState.spanFilter = filter;
    });
    const trace = makeTrace(['svc-a', 'svc-b']);
    const { rerender } = render(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    expect(mockStoreState.spanFilter).toEqual(serviceFilter('svc-b'));
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    expect(mockStoreState.spanFilter).toEqual(serviceFilter('svc-b'));
    mockSetSpanFilter.mockImplementation(() => undefined);
  });

  it('applies a saved default that hides the root once the page settles on the GenAI view', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-a'] }));
    mockSetSpanFilter.mockImplementation((filter: ISpanFilter) => {
      mockStoreState.spanFilter = filter;
    });
    const trace = makeTrace(['svc-a', 'svc-b']);
    (trace as unknown as { spans: IOtelSpan[] }).spans = [
      { spanID: 'root', resource: { serviceName: 'svc-a' }, parentSpan: undefined },
      { spanID: 'llm', resource: { serviceName: 'svc-b' }, parentSpan: undefined, genAIKind: 'LLM_CALL' },
    ] as unknown as IOtelSpan[];
    // The page renders the plain view first, where root protection drops the saved default.
    const { rerender } = render(React.createElement(HookRenderer, { trace, mode: 'inline' }));
    expect(mockStoreState.spanFilter).toEqual(EMPTY_SPAN_FILTER);
    // The auto-switch to the GenAI view resolves afresh, and lift mode may hide the root.
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    expect(mockStoreState.spanFilter).toEqual(
      normalizeFilter(withHiddenServices(GENAI_VIEW_FILTER, new Set(['svc-a'])))
    );
    mockSetSpanFilter.mockImplementation(() => undefined);
  });

  it('keeps the service selection across a view switch instead of re-applying the saved default', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    mockSetSpanFilter.mockImplementation((filter: ISpanFilter) => {
      mockStoreState.spanFilter = filter;
    });
    const trace = makeTrace(['svc-a', 'svc-b']);
    const { rerender } = render(
      React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER })
    );
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(
      normalizeFilter(withHiddenServices(GENAI_VIEW_FILTER, new Set(['svc-b'])))
    );

    // The user shows svc-b again; the write carries the remaining clauses and no svcFilter.
    capturedOnChange!(GENAI_VIEW_FILTER);
    const navigated = mockNavigate.mock.calls.at(-1)![0] as { search: string };
    expect(navigated.search).toBe('?f=h%3AspanType%3Anone&tree=lift');
    vi.mocked(useLocation).mockReturnValue({
      search: navigated.search,
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    expect(mockStoreState.spanFilter).toEqual(GENAI_VIEW_FILTER);

    // Switching to the plain view re-runs the resolve for the same URL and keeps svc-b shown.
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: null }));
    expect(mockStoreState.spanFilter).toEqual(GENAI_VIEW_FILTER);
    // And back, with the same result.
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    expect(mockStoreState.spanFilter).toEqual(GENAI_VIEW_FILTER);
    mockSetSpanFilter.mockImplementation(() => undefined);
  });

  it('does not re-resolve the filter when the detail panel mode changes', () => {
    localStorage.setItem('svcFilter.defaults', JSON.stringify({ prunedServices: ['svc-b'] }));
    vi.mocked(useLocation).mockReturnValue({
      search: '?f=&tree=lift',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    mockSetSpanFilter.mockImplementation((filter: ISpanFilter) => {
      mockStoreState.spanFilter = filter;
    });
    const trace = makeTrace(['svc-a', 'svc-b']);
    const { rerender } = render(
      React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER })
    );
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(
      withHiddenServices({ ...EMPTY_SPAN_FILTER, treeMode: 'lift' }, new Set(['svc-b']))
    );
    // The user shows svc-b again; the URL is unchanged because the saved default wrote nothing.
    capturedOnChange!({ ...EMPTY_SPAN_FILTER, treeMode: 'lift' });
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith({ ...EMPTY_SPAN_FILTER, treeMode: 'lift' });
    const calls = mockSetSpanFilter.mock.calls.length;
    rerender(React.createElement(HookRenderer, { trace, mode: 'sidepanel', viewDefault: GENAI_VIEW_FILTER }));
    expect(mockSetSpanFilter).toHaveBeenCalledTimes(calls);
    mockSetSpanFilter.mockImplementation(() => undefined);
  });

  it('does not rewrite the store when the URL resolves to the filter it already holds', () => {
    const keep: IClause = {
      verb: 'keep',
      criterion: { shape: 'set', property: 'status', values: ['error'] },
    };
    mockStoreState.spanFilter = normalizeFilter(
      withHiddenServices({ ...EMPTY_SPAN_FILTER, clauses: [keep] }, new Set(['svc-b']))
    );
    vi.mocked(decodeSvcFilter).mockReturnValue({ visibleServices: new Set(['svc-a']), stale: false });
    vi.mocked(useLocation).mockReturnValue({
      search: '?f=k%3Astatus%3Aerror&svcFilter=abc.1',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    renderHook(() => useSpanFilter(makeTrace(['svc-a', 'svc-b']), 'inline'));
    expect(mockSetSpanFilter).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does not sanitize the root service away in lift mode', () => {
    mockStoreState.spanFilter = { ...EMPTY_SPAN_FILTER, treeMode: 'lift' };
    render(React.createElement(HookRenderer, { trace: makeTrace(['svc-a', 'svc-b']), mode: 'inline' }));
    capturedOnChange!(withHiddenServices({ ...EMPTY_SPAN_FILTER, treeMode: 'lift' }, new Set(['svc-a'])));
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(
      withHiddenServices({ ...EMPTY_SPAN_FILTER, treeMode: 'lift' }, new Set(['svc-a']))
    );
  });

  it('sanitizes the root service away in remove mode even when the button asks for it', () => {
    render(React.createElement(HookRenderer, { trace: makeTrace(['svc-a', 'svc-b']), mode: 'inline' }));
    capturedOnChange!(withHiddenServices(EMPTY_SPAN_FILTER, new Set(['svc-a', 'svc-b'])));
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(
      withHiddenServices(EMPTY_SPAN_FILTER, new Set(['svc-b']))
    );
  });

  it('saves the service selection as the default when asked', () => {
    render(React.createElement(HookRenderer, { trace: makeTrace(['svc-a', 'svc-b']), mode: 'inline' }));
    capturedOnChange!(withHiddenServices(EMPTY_SPAN_FILTER, new Set(['svc-b'])), { saveAsDefault: true });
    expect(JSON.parse(localStorage.getItem('svcFilter.defaults') ?? '{}').prunedServices).toEqual(['svc-b']);
  });

  it('drops the search text from the URL in the same navigation when asked', () => {
    vi.mocked(useLocation).mockReturnValue({
      search: '?uiFind=auth&foo=1',
      pathname: '/trace/abc',
    } as ReturnType<typeof useLocation>);
    const { result } = renderHook(() => useSpanFilter(makeTrace(['svc-a', 'svc-b']), 'inline'));
    result.current.applyFilter(
      { ...EMPTY_SPAN_FILTER, clauses: [{ verb: 'hide', criterion: { shape: 'text', text: 'auth' } }] },
      { clearUiFind: true }
    );
    expect(mockNavigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: '?f=h%3Atext%3Aauth&foo=1' }),
      expect.anything()
    );
  });

  it('preserves the other clauses when the popover applies a service selection', () => {
    const keep: IClause = {
      verb: 'keep',
      criterion: { shape: 'set', property: 'status', values: ['error'] },
    };
    mockStoreState.spanFilter = { ...EMPTY_SPAN_FILTER, clauses: [keep] };
    render(React.createElement(HookRenderer, { trace: makeTrace(['svc-a', 'svc-b']), mode: 'inline' }));
    capturedOnChange!(withHiddenServices({ ...EMPTY_SPAN_FILTER, clauses: [keep] }, new Set(['svc-b'])));
    // The hook lists the clauses in the chip order, service first.
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(
      normalizeFilter(withHiddenServices({ ...EMPTY_SPAN_FILTER, clauses: [keep] }, new Set(['svc-b'])))
    );
    expect(mockNavigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: expect.stringContaining('f=k%3Astatus%3Aerror') }),
      expect.anything()
    );
  });

  it('re-resolves the filter when the view default changes', () => {
    const trace = makeTrace(['svc-a', 'svc-b']);
    const { rerender } = render(
      React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER })
    );
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(GENAI_VIEW_FILTER);
    mockStoreState.spanFilter = GENAI_VIEW_FILTER;
    rerender(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: null }));
    expect(mockSetSpanFilter).toHaveBeenLastCalledWith(EMPTY_SPAN_FILTER);
  });

  it('writes an empty f when the popover clears the view default', () => {
    const trace = makeTrace(['svc-a', 'svc-b']);
    render(React.createElement(HookRenderer, { trace, mode: 'inline', viewDefault: GENAI_VIEW_FILTER }));
    capturedOnChange!({ ...GENAI_VIEW_FILTER, clauses: [] });
    expect((mockNavigate.mock.calls.at(-1)![0] as { search: string }).search).toBe('?f=&tree=lift');
  });

  it('does not clear detailStates in inline mode when service is pruned via onApply', () => {
    const selectedSpanID = 'span-x';
    const selectedSpan = {
      spanID: selectedSpanID,
      resource: { serviceName: 'svc-b' },
      parentSpan: undefined,
    } as unknown as IOtelSpan;
    mockStoreState.detailStates = new Map([[selectedSpanID, {}]]) as typeof mockStoreState.detailStates;
    const trace = makeTrace(['svc-a', 'svc-b']);
    (trace as unknown as { spans: IOtelSpan[] }).spans = [selectedSpan];

    render(React.createElement(HookRenderer, { trace, mode: 'inline' }));

    expect(capturedOnChange).not.toBeNull();
    capturedOnChange!(withHiddenServices(EMPTY_SPAN_FILTER, new Set(['svc-b'])));

    const storeSetState = (useTraceTimelineStore as unknown as { setState: ReturnType<typeof vi.fn> })
      .setState;
    expect(storeSetState).not.toHaveBeenCalled();
  });
});
