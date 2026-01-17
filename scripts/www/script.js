(function () {
  const CONFIG = {
    accessCodes: {
      all: '123456', 本级: '111111', 瑞安: '222222', 乐清: '333333',
      苍南: '444444', 平阳: '555555', 永嘉: '666666', 泰顺: '777777', 文成: '888888'
    },
    map: {
      center: [120.65, 28.01],
      zoom: 10,
      resizeEnable: true,
      searchZoomLevel: 16,
    },
    labels: {
      minZoomToShowLabel: 14,
      limit: 300, // Increased for modern device performance
    },
    heatmap: {
      radius: 25, // Adjusted for mobile screen
      opacity: [0.3, 0.9],
      zIndex: 5,
      heatmapMaxFactor: 25
    },
    districtLayer: {
      adcode: [330300], depth: 3, styles: { 'fill': '#00000000', 'province-stroke': '#000000', 'city-stroke': '#000000', 'county-stroke': '#000000'}
    },
    customerTypes: ['存量客户', '流失客户', '潜在客户'],
    deliveryTypes: ['配送客户', '自提客户'],
    allCustomerType: '所有客户类型',
    allDeliveryType: '所有配送方式'
  };

  let currentDep = null;
  let allData = [];
  let map = null;
  let heatmapInstance = null;
  let geolocationControl = null;
  let myLocationPromise = null;
  let hasCenteredOnMyLocation = false;
  let toastTimer = null;
  const labelMarkersByKey = new Map();
  let currentMarkerKeys = new Set();
  let suppressMapClickUntil = 0;
  let geoDiagnostics = {
    status: 'idle',
    method: '',
    locationType: '',
    info: '',
    message: '',
    accuracy: null,
    updatedAt: 0,
    scheme: typeof window !== 'undefined' ? window.location?.protocol || '' : ''
  };

  function escapeHtml(value) {
    const s = String(value ?? '');
    return s
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function toNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function normalizeFactor(factor) {
    return {
      ...factor,
      name: String(factor?.name ?? ''),
      value: toNumber(factor?.value, 0),
    };
  }

  function normalizeItem(item) {
    return {
      ...item,
      name: String(item?.name ?? ''),
      dep: String(item?.dep ?? ''),
      add: String(item?.add ?? ''),
      profile: String(item?.profile ?? ''),
      customerType: String(item?.customerType ?? ''),
      deliveryType: String(item?.deliveryType ?? ''),
      lng: toNumber(item?.lng, NaN),
      lat: toNumber(item?.lat, NaN),
      count: toNumber(item?.count, 0),
      factors: (Array.isArray(item?.factors) ? item.factors : []).map(normalizeFactor)
    };
  }

  function normalizeData(data) {
    return (Array.isArray(data) ? data : []).map(normalizeItem);
  }

  function normalizeLngLat(pos) {
    const lng = toNumber(pos?.lng ?? (typeof pos?.getLng === 'function' ? pos.getLng() : NaN), NaN);
    const lat = toNumber(pos?.lat ?? (typeof pos?.getLat === 'function' ? pos.getLat() : NaN), NaN);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lng, lat };
  }

  function centerMapOnMyLocation(loc) {
    if (!map || !loc) return;
    if (hasCenteredOnMyLocation) return;
    hasCenteredOnMyLocation = true;
    const nextZoom = Math.max(toNumber(map.getZoom?.(), CONFIG.map.zoom), 12);
    map.setZoomAndCenter(nextZoom, [loc.lng, loc.lat]);
  }

  function updateGeoDiagnostics(partial) {
    geoDiagnostics = { ...geoDiagnostics, ...(partial || {}), updatedAt: Date.now() };
    try {
      if (typeof window.__updateGeoDiagnostics === 'function') {
        window.__updateGeoDiagnostics(geoDiagnostics);
      }
    } catch (_) {}
  }

  function setMyLocation(loc, meta) {
    const normalized = normalizeLngLat(loc);
    if (!normalized) return false;
    store.setState({ myLocation: normalized });
    updateGeoDiagnostics({
      status: String(meta?.status || 'success'),
      method: String(meta?.method || ''),
      locationType: String(meta?.locationType || ''),
      info: String(meta?.info || ''),
      message: String(meta?.message || ''),
      accuracy: Number.isFinite(Number(meta?.accuracy)) ? Number(meta.accuracy) : null
    });
    centerMapOnMyLocation(normalized);
    return true;
  }

  function ensureGeolocationControl() {
    if (geolocationControl) return geolocationControl;
    if (!window.AMap) return null;
    geolocationControl = new AMap.Geolocation({
      enableHighAccuracy: true,
      timeout: 5000,
      position: 'RB',
      offset: [10, 20],
      zoomToAccuracy: true,
      GeoLocationFirst: false,
      convert: true,
      getCityWhenFail: true,
      extensions: 'base'
    });
    if (map) map.addControl(geolocationControl);
    return geolocationControl;
  }

  function getMyLocation(options) {
    const { force, centerMap } = { force: false, centerMap: false, ...(options || {}) };
    const cached = store.getState().myLocation;
    if (!force && cached && Number.isFinite(cached.lng) && Number.isFinite(cached.lat)) {
      if (centerMap) centerMapOnMyLocation(cached);
      return Promise.resolve(cached);
    }
    if (!force && myLocationPromise) {
      return myLocationPromise.then(loc => {
        if (centerMap) centerMapOnMyLocation(loc);
        return loc;
      });
    }

    const geo = ensureGeolocationControl();
    if (!geo) return Promise.reject(new Error('Geolocation not ready'));

    myLocationPromise = new Promise((resolve, reject) => {
      updateGeoDiagnostics({ status: 'locating', method: 'getCurrentPosition' });
      geo.getCurrentPosition((status, result) => {
        if (status === 'complete') {
          const loc = normalizeLngLat(result?.position);
          if (loc) {
            setMyLocation(loc, {
              status: 'success',
              method: 'getCurrentPosition',
              locationType: result?.location_type,
              info: result?.info,
              message: result?.message,
              accuracy: result?.accuracy
            });
            resolve(loc);
            return;
          }
        }
        
        // Fallback to City Info (IP Location)
        updateGeoDiagnostics({
          status: 'error',
          method: 'getCurrentPosition',
          locationType: result?.location_type,
          info: result?.info,
          message: result?.message
        });
        geo.getCityInfo((statusCity, resultCity) => {
           if (statusCity === 'complete') {
              let pos = resultCity?.position;
              if (!pos && Array.isArray(resultCity?.center)) {
                  pos = { lng: resultCity.center[0], lat: resultCity.center[1] };
              }
              const loc = normalizeLngLat(pos);
              if (loc) {
                 setMyLocation(loc, {
                   status: 'fallback_success',
                   method: 'getCityInfo',
                   locationType: resultCity?.location_type || 'ipcity',
                   info: resultCity?.info,
                   message: resultCity?.message
                 });
                 resolve(loc);
                 return;
              }
           }
           updateGeoDiagnostics({
             status: 'fallback_error',
             method: 'getCityInfo',
             locationType: resultCity?.location_type || 'ipcity',
             info: resultCity?.info,
             message: resultCity?.message
           });
           const reason = String(result?.info || result?.message || resultCity?.info || resultCity?.message || '定位失败');
           reject(new Error(reason));
        });
      });
    }).finally(() => {
      myLocationPromise = null;
    });

    return myLocationPromise.then(loc => {
      if (centerMap) centerMapOnMyLocation(loc);
      return loc;
    });
  }

  window.__setMyLocation = function (payload) {
    const lng = toNumber(payload?.lng, NaN);
    const lat = toNumber(payload?.lat, NaN);
    const accuracy = toNumber(payload?.accuracy, NaN);
    window.__pendingMyLocation = { lng, lat, accuracy, message: payload?.message };
    try {
      if (typeof window.__applyPendingMyLocation === 'function') {
        return window.__applyPendingMyLocation();
      }
    } catch (_) {}
    return true;
  };

  function toast(message, durationMs) {
    const el = document.getElementById('app-toast');
    if (!el) {
      console.warn(String(message || ''));
      return;
    }
    el.textContent = String(message || '');
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, toNumber(durationMs, 1600));
  }

  function createStore(initialState) {
    let state = initialState;
    const listeners = new Set();
    return {
      getState() { return state; },
      setState(partial) {
        state = { ...state, ...partial };
        listeners.forEach(fn => fn(state));
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }
    };
  }

  function getDefaultFilters(dep) {
    return {
      dep: dep ?? null,
      minDemand: 0,
      maxDemand: Infinity,
      customerTypes: [CONFIG.allCustomerType],
      deliveryTypes: [CONFIG.allDeliveryType]
    };
  }

  function resetSearchState(keyword) {
    return { keyword: keyword ?? '', matches: [], index: -1 };
  }

  const store = createStore({
    filters: getDefaultFilters(null),
    filteredData: [],
    search: resetSearchState(''),
    myLocation: null,
    waypoints: []
  });

  window.__applyPendingMyLocation = function () {
    const p = window.__pendingMyLocation;
    if (!p) return false;
    return setMyLocation({ lng: p.lng, lat: p.lat }, { status: 'native', method: 'native', accuracy: p.accuracy, message: p.message });
  };
  window.__applyPendingMyLocation();

  const dom = {
    searchInput: document.getElementById('search-input'),
    searchCounter: document.getElementById('search-counter'),
    minDemand: document.getElementById('min-demand'),
    maxDemand: document.getElementById('max-demand'),
    geoDebugToggle: document.getElementById('geo-debug-toggle'),
    geoDebugPanel: document.getElementById('geo-debug-panel'),
    geoDebugClose: document.getElementById('geo-debug-close'),
    geoDebugContent: document.getElementById('geo-debug-content'),
  };

  function setSearchState(next) {
    store.setState({ search: { ...store.getState().search, ...next } });
  }

  function renderSearchCounter(current, total, isError) {
    if (!dom.searchCounter) return;
    if (total == null) {
      dom.searchCounter.style.display = 'none';
      dom.searchCounter.textContent = '';
      dom.searchCounter.style.color = '';
      return;
    }
    dom.searchCounter.textContent = `${current}/${total}`;
    dom.searchCounter.style.display = 'block';
    dom.searchCounter.style.color = isError ? 'red' : '#555';
  }

  function isGeoDebugEnabled() {
    try {
      const qs = new URLSearchParams(window.location.search || '');
      if (qs.get('geoDebug') === '1') return true;
      const hash = String(window.location.hash || '');
      if (hash.includes('geoDebug')) return true;
      if (window.localStorage && window.localStorage.getItem('geoDebug') === '1') return true;
    } catch (_) {}
    return false;
  }

  function setGeoDebugPanelVisible(visible) {
    if (!dom.geoDebugPanel) return;
    if (visible) dom.geoDebugPanel.classList.remove('hidden');
    else dom.geoDebugPanel.classList.add('hidden');
  }

  function formatDiagnosticsText(diag) {
    const d = diag || {};
    const myLoc = store.getState().myLocation;
    const time = d.updatedAt ? new Date(d.updatedAt).toLocaleString() : '';
    const lines = [
      `scheme: ${String(d.scheme || window.location?.protocol || '')}`,
      `status: ${String(d.status || '')}`,
      `method: ${String(d.method || '')}`,
      `location_type: ${String(d.locationType || '')}`,
      `accuracy(m): ${d.accuracy == null ? '' : String(d.accuracy)}`,
      `info: ${String(d.info || '')}`,
      `message: ${String(d.message || '')}`,
      `updated_at: ${time}`,
      '',
      `myLocation: ${myLoc && Number.isFinite(myLoc.lng) && Number.isFinite(myLoc.lat) ? `${myLoc.lng},${myLoc.lat}` : ''}`
    ];
    return lines.join('\n');
  }

  function renderGeoDiagnosticsUI(diag) {
    if (!dom.geoDebugContent) return;
    dom.geoDebugContent.textContent = formatDiagnosticsText(diag);
  }

  window.__updateGeoDiagnostics = function (diag) {
    renderGeoDiagnosticsUI(diag);
  };

  if (isGeoDebugEnabled() && dom.geoDebugToggle) {
    dom.geoDebugToggle.classList.remove('hidden');
    dom.geoDebugToggle.addEventListener('click', () => {
      setGeoDebugPanelVisible(true);
      renderGeoDiagnosticsUI(geoDiagnostics);
    });
  }
  if (dom.geoDebugClose) {
    dom.geoDebugClose.addEventListener('click', () => setGeoDebugPanelVisible(false));
  }
  if (dom.geoDebugPanel) {
    dom.geoDebugPanel.addEventListener('click', (e) => {
      if (e.target === dom.geoDebugPanel) setGeoDebugPanelVisible(false);
    });
  }
  updateGeoDiagnostics({});

  function applyFilters(data, filters) {
    return data.filter(item => {
      if (!Number.isFinite(item.lng) || !Number.isFinite(item.lat)) return false;
      if (filters.dep && !String(item.dep).includes(filters.dep)) return false;
      if (item.count < filters.minDemand || item.count > filters.maxDemand) return false;

      const customerMatch = filters.customerTypes.includes(CONFIG.allCustomerType) || filters.customerTypes.includes(item.customerType);
      const deliveryMatch = filters.deliveryTypes.includes(CONFIG.allDeliveryType) || filters.deliveryTypes.includes(item.deliveryType);
      return customerMatch && deliveryMatch;
    });
  }

  function recomputeFilteredData() {
    const { filters } = store.getState();
    store.setState({ filteredData: applyFilters(allData, filters) });
  }

  function setFilters(patch) {
    const prev = store.getState();
    const nextFilters = { ...prev.filters, ...patch };
    store.setState({ filters: nextFilters, search: resetSearchState(prev.search.keyword) });
    renderSearchCounter(null, null, false);
    recomputeFilteredData();
  }

  function toggleTypeFilter(type) {
    const { filters } = store.getState();
    const isCustomer = CONFIG.customerTypes.includes(type) || type === CONFIG.allCustomerType;
    const key = isCustomer ? 'customerTypes' : 'deliveryTypes';
    const allType = isCustomer ? CONFIG.allCustomerType : CONFIG.allDeliveryType;
    const prev = filters[key];
    const next = [...prev];

    if (type === allType) {
      if (!next.includes(allType)) {
        next.length = 0;
        next.push(allType);
      }
    } else {
      const allIndex = next.indexOf(allType);
      if (allIndex > -1) next.splice(allIndex, 1);

      const tIndex = next.indexOf(type);
      if (tIndex > -1) {
        next.splice(tIndex, 1);
        if (next.length === 0) next.push(allType);
      } else {
        next.push(type);
      }
    }

    setFilters({ [key]: next });
  }

  function renderLegendActive(filters) {
    void filters;
  }

  function renderHeatmap(data) {
    if (!heatmapInstance) return;
    heatmapInstance.setDataSet({ data, max: 100 });
  }

  function computeStats(data) {
    const stats = {
      totalCount: 0,
      totalDemand: 0,
      byCustomerType: new Map(),
      byDeliveryType: new Map()
    };

    CONFIG.customerTypes.forEach(t => stats.byCustomerType.set(t, { count: 0, demand: 0 }));
    CONFIG.deliveryTypes.forEach(t => stats.byDeliveryType.set(t, { count: 0, demand: 0 }));

    data.forEach(item => {
      const demand = toNumber(item.count, 0);
      stats.totalCount += 1;
      stats.totalDemand += demand;

      const c = stats.byCustomerType.get(item.customerType);
      if (c) { c.count += 1; c.demand += demand; }

      const d = stats.byDeliveryType.get(item.deliveryType);
      if (d) { d.count += 1; d.demand += demand; }
    });

    return stats;
  }

  function formatVal(count, demand) {
    return `${count} 个，${(demand / 10000).toFixed(2)}万吨`;
  }

  function renderStatsActive(filters) {
    document.querySelectorAll('.stat-row[data-type]').forEach(item => {
      const type = item.dataset.type;
      const isCustomer = CONFIG.customerTypes.includes(type) || type === CONFIG.allCustomerType;
      const key = isCustomer ? 'customerTypes' : 'deliveryTypes';
      if (filters[key].includes(type)) item.classList.add('active');
      else item.classList.remove('active');
    });
  }

  store.subscribe(state => {
    renderHeatmap(state.filteredData);
    updateStats();
    updateLabels();
  });
  
  // Access Code Logic
  const accessCodeModal = document.getElementById('access-code-modal');
  const accessCodeInput = document.getElementById('access-code-input');
  const accessCodeSubmit = document.getElementById('access-code-submit');
  const accessCodeError = document.getElementById('access-code-error');

  function ensureAmapReady() {
    const p = window.__amapReadyPromise;
    if (p && typeof p.then === 'function') return p;
    if (window.AMap) return Promise.resolve(window.AMap);
    return Promise.reject(new Error('AMap not loaded'));
  }

  function checkAccessCode() {
    const code = accessCodeInput.value.trim();
    let valid = false;
    for (const [dep, accessCode] of Object.entries(CONFIG.accessCodes)) {
      if (code === accessCode) {
        currentDep = dep === 'all' ? null : dep;
        valid = true;
        break;
      }
    }

    if (valid) {
      accessCodeModal.classList.add('hidden');
      document.getElementById('container').classList.remove('hidden');
      document.getElementById('mobile-search-bar').classList.remove('hidden');
      ensureAmapReady()
        .then(() => initMap())
        .catch(() => {
          accessCodeError.textContent = '地图加载失败';
        });
    } else {
      accessCodeError.textContent = '访问码错误';
    }
  }

  if (accessCodeSubmit) {
      accessCodeSubmit.addEventListener('click', checkAccessCode);
      accessCodeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') checkAccessCode();
      });
  }

  function initMap() {
    map = new AMap.Map('container', CONFIG.map);

    ensureGeolocationControl();
    getMyLocation({ centerMap: true }).catch(() => {});

    const disCountry = new AMap.DistrictLayer.Province(CONFIG.districtLayer);
    map.add(disCountry);

    heatmapInstance = new AMap.HeatMap(map, CONFIG.heatmap);
    allData = normalizeData(window.allHeatmapData || []);
    store.setState({ filters: getDefaultFilters(currentDep) });
    recomputeFilteredData();

    map.on('zoomend', updateLabels);
    map.on('moveend', updateLabels);

    map.on('click', () => {
      if (Date.now() < suppressMapClickUntil) return;
      closeProfile();
    });
    
    setupControls();
  }

  function setupControls() {
    // Search
    const searchBtn = document.getElementById('search-button');
    if(searchBtn) searchBtn.addEventListener('click', performSearch);
    
    let searchDebounceTimer = null;
    if (dom.searchInput) {
      dom.searchInput.addEventListener('input', () => {
        const keyword = dom.searchInput.value.trim();
        
        // Immediate UI update for empty keyword or clearing search
        if (!keyword) {
           if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
           store.setState({ search: resetSearchState('') });
           renderSearchCounter(null, null, false);
           return;
        }

        // Debounce for typing
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            store.setState({ search: resetSearchState(keyword) });
            renderSearchCounter(null, null, false);
        }, 300);
      });
    }
    
    // Panel Toggles
    document.getElementById('filter-toggle-btn').addEventListener('click', () => togglePanel('filter-panel'));
    
    // Close Buttons
    const filterCloseBtn = document.querySelector('#filter-panel .close-panel-btn');
    if (filterCloseBtn) filterCloseBtn.addEventListener('click', () => closePanel('filter-panel'));

    const filterPanel = document.getElementById('filter-panel');
    if (filterPanel) {
      filterPanel.addEventListener('click', (e) => {
        if (e.target === filterPanel) closePanel('filter-panel');
      });
    }
    
    // Filter Actions
    const clearBtn = document.getElementById('clear-button');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (dom.minDemand) dom.minDemand.value = '';
        if (dom.maxDemand) dom.maxDemand.value = '';
        store.setState({ filters: getDefaultFilters(currentDep), search: resetSearchState(store.getState().search.keyword) });
        renderSearchCounter(null, null, false);
        recomputeFilteredData();
      });
    }

    const statsContainer = document.getElementById('stats-container');
    if (statsContainer) {
      statsContainer.addEventListener('click', (e) => {
        const row = e.target.closest('.stat-row[data-type]');
        if (!row) return;
        toggleTypeFilter(row.dataset.type);
      });
    }

    // Navigation Preview Panel Controls
    const closeNavPreviewBtn = document.getElementById('close-nav-preview');
    if (closeNavPreviewBtn) {
      closeNavPreviewBtn.addEventListener('click', () => NavigationModule.closeNavPreview());
    }

    const clearWaypointsBtn = document.getElementById('clear-waypoints-btn');
    if (clearWaypointsBtn) {
      clearWaypointsBtn.addEventListener('click', () => NavigationModule.clearWaypoints());
    }

    const startNavBtn = document.getElementById('start-nav-btn');
    if (startNavBtn) {
      startNavBtn.addEventListener('click', () => NavigationModule.startNavigationWithWaypoints());
    }

    const recenterPreviewBtn = document.getElementById('recenter-preview-btn');
    if (recenterPreviewBtn) {
      recenterPreviewBtn.addEventListener('click', () => NavigationModule.recenterPreviewOrigin());
    }

    const waypointList = document.getElementById('waypoint-list');
    if (waypointList) {
      waypointList.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-remove-waypoint-id]');
        if (!btn) return;
        const id = btn.getAttribute('data-remove-waypoint-id');
        NavigationModule.removeWaypoint(id);
      });
    }
    
  }

  function togglePanel(id) {
    const panel = document.getElementById(id);
    if (panel.classList.contains('hidden')) {
        closeProfile();
        panel.classList.remove('hidden');
    } else {
        panel.classList.add('hidden');
    }
  }

  function closePanel(id) {
    document.getElementById(id).classList.add('hidden');
  }
  


  function updateStats() {
    const container = document.getElementById('stats-container');
    if (!container) return;

    const stats = computeStats(store.getState().filteredData);
    const getCustomer = (t) => stats.byCustomerType.get(t) ?? { count: 0, demand: 0 };
    const getDelivery = (t) => stats.byDeliveryType.get(t) ?? { count: 0, demand: 0 };

    const existing = getCustomer('存量客户');
    const lost = getCustomer('流失客户');
    const potential = getCustomer('潜在客户');
    const delivery = getDelivery('配送客户');
    const selfPickup = getDelivery('自提客户');

    container.innerHTML = `
      <div class="stat-header">
        <span>总计</span>
        <span>${formatVal(stats.totalCount, stats.totalDemand)}</span>
      </div>

      <div class="stat-section">
        <div class="stat-section-title">客户<br>类型</div>
        <div class="stat-rows">
          <div class="stat-row" data-type="${CONFIG.allCustomerType}">
            <span class="stat-label">全部</span>
            <span class="stat-value">${formatVal(existing.count + lost.count + potential.count, existing.demand + lost.demand + potential.demand)}</span>
          </div>
          <div class="stat-row" data-type="存量客户">
            <span class="stat-label"><span class="stat-dot dot-existing"></span>存量</span>
            <span class="stat-value">${formatVal(existing.count, existing.demand)}</span>
          </div>
          <div class="stat-row" data-type="流失客户">
            <span class="stat-label"><span class="stat-dot dot-lost"></span>流失</span>
            <span class="stat-value">${formatVal(lost.count, lost.demand)}</span>
          </div>
          <div class="stat-row" data-type="潜在客户">
            <span class="stat-label"><span class="stat-dot dot-potential"></span>潜在</span>
            <span class="stat-value">${formatVal(potential.count, potential.demand)}</span>
          </div>
        </div>
      </div>

      <div class="stat-section">
        <div class="stat-section-title">配送<br>方式</div>
        <div class="stat-rows">
          <div class="stat-row" data-type="${CONFIG.allDeliveryType}">
            <span class="stat-label">全部</span>
            <span class="stat-value">${formatVal(delivery.count + selfPickup.count, delivery.demand + selfPickup.demand)}</span>
          </div>
          <div class="stat-row" data-type="配送客户">
            <span class="stat-label"><span class="stat-dot dot-delivery"></span>配送</span>
            <span class="stat-value">${formatVal(delivery.count, delivery.demand)}</span>
          </div>
          <div class="stat-row" data-type="自提客户">
            <span class="stat-label"><span class="stat-dot dot-self"></span>自提</span>
            <span class="stat-value">${formatVal(selfPickup.count, selfPickup.demand)}</span>
          </div>
        </div>
      </div>
    `;

    renderStatsActive(store.getState().filters);
  }

  function updateLabels() {
    if (!map) return;

    const zoom = map.getZoom();
    if (zoom < CONFIG.labels.minZoomToShowLabel) {
      if (currentMarkerKeys.size > 0) {
        for (const key of currentMarkerKeys) {
          const marker = labelMarkersByKey.get(key);
          if (marker) map.remove(marker);
        }
        currentMarkerKeys = new Set();
      }
      return;
    }

    const bounds = map.getBounds();
    const visiblePoints = store.getState().filteredData.filter(p => bounds.contains([p.lng, p.lat]));
    const pointsToShow = visiblePoints.slice(0, CONFIG.labels.limit);

    const nextKeys = new Set();
    pointsToShow.forEach(point => {
      const key = `${point.name}|${point.lng}|${point.lat}`;
      nextKeys.add(key);

      let className = 'custom-label';
      if (point.customerType === '存量客户') className += ' existing-customer-label';
      else if (point.customerType === '流失客户') className += ' lost-customer-label';
      else if (point.customerType === '潜在客户') className += ' potential-customer-label';

      const safeName = escapeHtml(point.name);
      const content = `<div class="${className}">${safeName}</div>`;

      let marker = labelMarkersByKey.get(key);
      if (!marker) {
        marker = new AMap.Marker({
          position: [point.lng, point.lat],
          content: content,
          offset: new AMap.Pixel(0, -15),
          zIndex: 100,
          extData: point,
          bubble: false
        });
        marker.__labelContent = content;

        const handleActivate = (e) => {
          suppressMapClickUntil = Date.now() + 350;
          if (e && e.originEvent && typeof e.originEvent.stopPropagation === 'function') {
            e.originEvent.stopPropagation();
          } else if (e && typeof e.stopPropagation === 'function') {
            e.stopPropagation();
          }
          const p = marker.getExtData ? marker.getExtData() : null;
          showProfile(p || point);
        };

        marker.on('click', handleActivate);
      marker.on('touchend', handleActivate);
      labelMarkersByKey.set(key, marker);
    } else {
      marker.setPosition([point.lng, point.lat]);
        if (marker.getExtData && marker.setExtData) marker.setExtData(point);
        if (marker.__labelContent !== content) {
          marker.setContent(content);
          marker.__labelContent = content;
        }
      }

      map.add(marker);
    });

    if (currentMarkerKeys.size > 0) {
      for (const key of currentMarkerKeys) {
        if (nextKeys.has(key)) continue;
        const marker = labelMarkersByKey.get(key);
        if (marker) map.remove(marker);
      }
    }
    currentMarkerKeys = nextKeys;

    const maxCacheSize = CONFIG.labels.limit * 3;
    if (labelMarkersByKey.size > maxCacheSize) {
      for (const [key, marker] of labelMarkersByKey) {
        if (currentMarkerKeys.has(key)) continue;
        if (marker && marker.getMap && marker.getMap() == null) {
          map.remove(marker);
          labelMarkersByKey.delete(key);
        }
        if (labelMarkersByKey.size <= maxCacheSize) break;
      }
    }
  }

  // Gesture Logic
  let gestureState = {
    startY: 0,
    currentTranslate: 0,
    isDragging: false
  };

  function initProfileGestures() {
    const container = document.getElementById('profile-container');
    if (!container) return;

    container.addEventListener('touchstart', (e) => {
        if (!e.target.closest('.card-header')) return;
        
        gestureState.isDragging = true;
        gestureState.startY = e.touches[0].clientY;
        gestureState.currentTranslate = 0;
        
        container.classList.add('is-dragging');
    }, { passive: false });

    container.addEventListener('touchmove', (e) => {
        if (!gestureState.isDragging) return;
        if (e.cancelable) e.preventDefault();
        
        const deltaY = e.touches[0].clientY - gestureState.startY;
        const newTranslate = Math.max(0, deltaY);
        gestureState.currentTranslate = newTranslate;
        container.style.transform = `translateY(${newTranslate}px)`;
    }, { passive: false });

    container.addEventListener('touchend', (e) => {
        if (!gestureState.isDragging) return;
        gestureState.isDragging = false;
        container.classList.remove('is-dragging');

        if (gestureState.currentTranslate > 40) {
          closeProfile();
        } else {
          container.style.transform = 'translateY(0)';
        }
    });
  }
  
  // Initialize gestures
  initProfileGestures();

  function closeProfile() {
      const container = document.getElementById('profile-container');
      if (!container) return;
      container.style.transform = 'translateY(100%)';
      container.classList.remove('active');
      setTimeout(() => {
          if (!container.classList.contains('active')) {
              container.style.display = 'none';
          }
      }, 300);
  }

  const NavigationModule = {
    config: {
      timeout: 500,
      sourceApp: '温石客户系统',
      navigationMode: 'car',
      debounceMs: 1500
    },

    state: {
      lastNavAt: 0,
      driving: null,
      previewMap: null,
      activeCustomerForNav: null,
      previewSeq: 0
    },

    toLngLat(pos) {
      if (!window.AMap) return null;
      const normalized = normalizeLngLat(pos);
      if (!normalized) return null;
      return new AMap.LngLat(normalized.lng, normalized.lat);
    },

    ensureDrivingReady() {
      if (window.AMap?.Driving) return Promise.resolve();
      if (typeof window.AMap?.plugin === 'function') {
        return new Promise(resolve => {
          window.AMap.plugin('AMap.Driving', function () {
            resolve();
          });
        });
      }
      return Promise.resolve();
    },

    resolvePreviewOrigin() {
      return getMyLocation({ force: false, centerMap: false })
        .then(loc => ({ origin: new AMap.LngLat(loc.lng, loc.lat), hint: '' }))
        .catch(() => {
          const cached = store.getState().myLocation;
          if (cached && Number.isFinite(cached.lng) && Number.isFinite(cached.lat)) {
            return { origin: new AMap.LngLat(cached.lng, cached.lat), hint: '使用缓存定位预览路线' };
          }

          const fromMainMap = map && typeof map.getCenter === 'function' ? this.toLngLat(map.getCenter()) : null;
          if (fromMainMap) return { origin: fromMainMap, hint: '定位不可用，已按地图中心预览路线' };

          const fromPreviewMap = this.state.previewMap && typeof this.state.previewMap.getCenter === 'function' ? this.toLngLat(this.state.previewMap.getCenter()) : null;
          if (fromPreviewMap) return { origin: fromPreviewMap, hint: '定位不可用，已按地图中心预览路线' };

          const cfgCenter = Array.isArray(CONFIG?.map?.center) ? { lng: CONFIG.map.center[0], lat: CONFIG.map.center[1] } : null;
          const fromConfig = cfgCenter ? this.toLngLat(cfgCenter) : null;
          return { origin: fromConfig, hint: '定位不可用，已按默认中心预览路线' };
        });
    },

    normalizeWaypoint(point) {
      const lng = toNumber(point?.lng, NaN);
      const lat = toNumber(point?.lat, NaN);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
      const id = String(point?.id || `${lng.toFixed(6)},${lat.toFixed(6)}`);
      return {
        id,
        lng,
        lat,
        name: String(point?.name ?? '').trim(),
        address: String(point?.address ?? '').trim()
      };
    },

    setActiveCustomer(point) {
      const normalized = this.normalizeWaypoint(point);
      this.state.activeCustomerForNav = normalized;
    },

    isSameWaypoint(a, b) {
      if (!a || !b) return false;
      if (a.id && b.id && a.id === b.id) return true;
      return Math.abs(a.lat - b.lat) < 0.00001 && Math.abs(a.lng - b.lng) < 0.00001;
    },

    removeWaypoint(id) {
      const current = store.getState().waypoints;
      const next = current.filter(p => p && p.id !== id);
      if (next.length === current.length) return;
      store.setState({ waypoints: next });
      this.renderNavPreview();
    },

    recenterPreviewOrigin() {
      toast('正在重新定位...');
      getMyLocation({ force: true, centerMap: false })
        .then(loc => {
          if (this.state.previewMap && typeof this.state.previewMap.setCenter === 'function') {
            this.state.previewMap.setCenter([loc.lng, loc.lat]);
          }
          this.renderNavPreview();
        })
        .catch(() => {
          toast('重新定位失败');
        });
    },

    addToWaypoints(point) {
      const current = store.getState().waypoints;
      const nextPoint = this.normalizeWaypoint(point);
      if (!nextPoint) {
        toast('无效地点，无法加入途径点');
        return;
      }
      const exists = current.some(p => this.isSameWaypoint(p, nextPoint));
      if (exists) {
        toast('该地点已在途径点列表中');
        return;
      }

      if (current.length >= 16) {
        toast('最多支持 16 个途径点');
        return;
      }
      
      const next = [...current, nextPoint];
      store.setState({ waypoints: next });

      const displayName = nextPoint.name || '未命名地点';
      toast(`已加入途径点：${displayName}（共 ${next.length} 个）`);
      closeProfile();
    },

    setDestination(point) {
      const dest = this.normalizeWaypoint(point);
      if (!dest) {
        toast('无效目的地，无法导航');
        return null;
      }
      const current = store.getState().waypoints;
      const kept = current.filter(p => !this.isSameWaypoint(p, dest));
      const next = [...kept.slice(0, 15), dest];
      store.setState({ waypoints: next });
      return next;
    },

    previewToDestination(point) {
      const next = this.setDestination(point);
      if (!next) return;
      closeProfile();
      this.openNavPreview();
    },

    openNavPreview() {
      const panel = document.getElementById('nav-preview-panel');
      if (!panel) return;
      panel.classList.remove('hidden');
      
      // Delay render slightly to allow display:block to take effect for map sizing
      requestAnimationFrame(() => {
         if (this.state.previewMap && typeof this.state.previewMap.resize === 'function') {
           this.state.previewMap.resize();
         }
         this.renderNavPreview();
      });
    },

    closeNavPreview() {
      const panel = document.getElementById('nav-preview-panel');
      if (panel) panel.classList.add('hidden');
    },

    clearWaypoints() {
      store.setState({ waypoints: [] });
      if (this.state.driving) this.state.driving.clear();
      this.renderNavPreview();
    },

    setPreviewStatus(message) {
      const el = document.getElementById('nav-preview-status');
      if (!el) return;
      const text = String(message || '').trim();
      if (!text) {
        el.textContent = '';
        el.classList.add('hidden');
        return;
      }
      el.textContent = text;
      el.classList.remove('hidden');
    },

    setRoutePanelVisible(visible) {
      const el = document.getElementById('nav-preview-route-panel');
      if (!el) return;
      if (visible) el.classList.remove('hidden');
      else el.classList.add('hidden');
    },

    renderNavPreview() {
      const initialWaypoints = store.getState().waypoints;
      const hasWaypoints = Array.isArray(initialWaypoints) && initialWaypoints.length > 0;
      if (!hasWaypoints && this.state.activeCustomerForNav) {
        this.setDestination(this.state.activeCustomerForNav);
      }

      const waypoints = store.getState().waypoints;
      const countEl = document.getElementById('waypoint-count');
      if (countEl) countEl.textContent = `${waypoints.length} 个途径点`;

      const listEl = document.getElementById('waypoint-list');
      if (listEl) {
        if (!Array.isArray(waypoints) || waypoints.length === 0) {
          listEl.innerHTML = '';
        } else {
          listEl.innerHTML = waypoints.map((p, idx) => {
            const titlePrefix = idx === waypoints.length - 1 ? '终点：' : '';
            const title = `${titlePrefix}${escapeHtml(p?.name || '未命名')}`;
            const sub = escapeHtml(p?.address || `${toNumber(p?.lng, 0).toFixed(6)},${toNumber(p?.lat, 0).toFixed(6)}`);
            const id = escapeHtml(p?.id || '');
            return `
              <div class="waypoint-item">
                <div class="waypoint-item-main">
                  <div class="waypoint-item-title">${title}</div>
                  <div class="waypoint-item-subtitle">${sub}</div>
                </div>
                <button type="button" class="waypoint-remove-btn" data-remove-waypoint-id="${id}">×</button>
              </div>
            `;
          }).join('');
        }
      }

      const startNavBtn = document.getElementById('start-nav-btn');
      if (startNavBtn) startNavBtn.disabled = !(Array.isArray(waypoints) && waypoints.length > 0);
      
      if (!Array.isArray(waypoints) || waypoints.length === 0) {
        this.setPreviewStatus('请选择客户或先添加途径点');
        this.setRoutePanelVisible(false);
        if (this.state.driving) this.state.driving.clear();
        return;
      }

      if (!window.AMap) {
        this.setPreviewStatus('地图未就绪，请稍后重试');
        return;
      }

      this.setPreviewStatus('正在规划路线...');
      this.setRoutePanelVisible(true);
      const seq = ++this.state.previewSeq;
      const capped = waypoints.slice(0, 16);
      const destination = new AMap.LngLat(capped[capped.length - 1].lng, capped[capped.length - 1].lat);

      const buildWaypointsForDriving = (startIndexInclusive, endIndexExclusive) => {
        const slice = capped.slice(startIndexInclusive, endIndexExclusive);
        if (slice.length === 0) return undefined;
        return slice.map(p => new AMap.LngLat(p.lng, p.lat));
      };

      const handleResult = (status, result, successMessage) => {
        if (seq !== this.state.previewSeq) return;
        if (status === 'complete') {
          const route = result?.routes?.[0];
          if (route && Number.isFinite(route.distance) && Number.isFinite(route.time)) {
            const km = (route.distance / 1000).toFixed(1);
            const min = Math.round(route.time / 60);
            this.setPreviewStatus(successMessage ? `${successMessage}（约 ${km} km / ${min} 分钟）` : `约 ${km} km / ${min} 分钟`);
          } else {
            this.setPreviewStatus(successMessage || '');
          }
          return;
        }
        if (status === 'no_data') {
          this.setPreviewStatus('未找到可用路线，可直接点击“开始导航”');
          this.setRoutePanelVisible(false);
          if (this.state.driving) this.state.driving.clear();
          return;
        }
        const info = typeof result?.info === 'string' ? result.info : '';
        const statusText = typeof status === 'string' ? status : '';
        const combined = [info, statusText].filter(Boolean).join(' / ');
        this.setPreviewStatus(combined ? `路线规划失败：${combined}` : '路线规划失败，可直接点击“开始导航”');
        this.setRoutePanelVisible(false);
        if (this.state.driving) this.state.driving.clear();
      };

      this.ensureDrivingReady()
        .then(() => {
          if (seq !== this.state.previewSeq) return;
          if (!this.state.previewMap) {
            this.state.previewMap = new AMap.Map('nav-preview-map-container', {
              resizeEnable: true,
              zoom: 12
            });
          } else if (typeof this.state.previewMap.resize === 'function') {
            this.state.previewMap.resize();
          }

          if (!this.state.driving) {
            this.state.driving = new AMap.Driving({
              map: this.state.previewMap,
              policy: 0,
              extensions: 'all',
              ferry: 0,
              hideMarkers: false,
              showTraffic: true,
              isOutline: true,
              outlineColor: 'white',
              autoFitView: true,
              panel: 'nav-preview-route-panel'
            });
          } else if (typeof this.state.driving.clear === 'function') {
            this.state.driving.clear();
          }
        })
        .then(() => {
          if (seq !== this.state.previewSeq) return;
          return this.resolvePreviewOrigin();
        })
        .then((resolved) => {
          if (seq !== this.state.previewSeq) return;
          if (!this.state.driving) {
            this.setPreviewStatus('路线规划服务未就绪');
            this.setRoutePanelVisible(false);
            return;
          }

          const resolvedOrigin = resolved?.origin || null;
          const resolvedHint = String(resolved?.hint || '');

          const searchWithOriginAndWaypoints = (origin, waypointStartIndexInclusive, hint) => {
            const waypointList = capped.length > 1 ? buildWaypointsForDriving(waypointStartIndexInclusive, capped.length - 1) : undefined;
            if (waypointList && waypointList.length > 0) {
              this.state.driving.search(origin, destination, { waypoints: waypointList }, (status, result) => {
                handleResult(status, result, hint);
              });
            } else {
              this.state.driving.search(origin, destination, (status, result) => {
                handleResult(status, result, hint);
              });
            }
          };

          if (resolvedOrigin) {
            searchWithOriginAndWaypoints(resolvedOrigin, 0, resolvedHint);
            return;
          }

          if (capped.length >= 2) {
            const origin = new AMap.LngLat(capped[0].lng, capped[0].lat);
            searchWithOriginAndWaypoints(origin, 1, '定位不可用，已按途径点顺序预览路线');
            return;
          }

          this.setPreviewStatus('无法获取起点信息，可直接点击“开始导航”');
          this.setRoutePanelVisible(false);
          if (this.state.driving) this.state.driving.clear();
        })
        .catch(() => {
          if (seq !== this.state.previewSeq) return;
          this.setPreviewStatus('路线预览初始化失败，可直接点击“开始导航”');
          this.setRoutePanelVisible(false);
          if (this.state.driving) this.state.driving.clear();
        });
    },

    async startNavigationWithWaypoints() {
      const waypoints = store.getState().waypoints;
      if (!Array.isArray(waypoints) || waypoints.length === 0) {
        toast('请先选择目的地或添加途径点');
        return;
      }
      
      let myLoc = null;
      let fromLabel = '我的位置';
      try {
        myLoc = await getMyLocation({ force: true, centerMap: false });
      } catch (_) {}
      if (!myLoc) {
        const cached = store.getState().myLocation;
        if (cached && Number.isFinite(cached.lng) && Number.isFinite(cached.lat)) myLoc = cached;
      }
      if (!myLoc && map && typeof map.getCenter === 'function') {
        const center = normalizeLngLat(map.getCenter());
        if (center) {
          myLoc = center;
          fromLabel = '地图中心';
        }
      }

      const params = new URLSearchParams();
      params.set('mode', this.config.navigationMode);
      params.set('src', this.config.sourceApp);
      params.set('callnative', '1');
      params.set('coordinate', 'gaode');
      
      if (myLoc && Number.isFinite(myLoc.lng) && Number.isFinite(myLoc.lat)) {
        params.set('from', `${myLoc.lng},${myLoc.lat},${fromLabel}`);
      } else {
        toast('无法获取定位，导航起点将由高德自动定位');
      }
      
      const dest = waypoints[waypoints.length - 1];
      const safeName = String(dest.name || '').replaceAll(',', ' ').trim();
      params.set('to', safeName ? `${dest.lng},${dest.lat},${safeName}` : `${dest.lng},${dest.lat}`);
      
      if (waypoints.length > 1) {
        // AMAP URI 'via' param: lon,lat;lon,lat...
        const vias = waypoints.slice(0, waypoints.length - 1)
          .map(p => `${p.lng},${p.lat}`)
          .join(';');
        params.set('via', vias);
      }
      
      const url = `https://uri.amap.com/navigation?${params.toString()}`;
      const win = window.open(url, '_blank');
      if (!win) window.location.assign(url);
    },

    navigateToCustomer(lat, lng, name, address) {
      const now = Date.now();
      if (now - this.state.lastNavAt < this.config.debounceMs) return;
      this.state.lastNavAt = now;

      const customerName = String(name || '目标位置');
      const latNum = Number(lat);
      const lngNum = Number(lng);
      const hasCoords = Number.isFinite(latNum) && Number.isFinite(lngNum) && latNum >= -90 && latNum <= 90 && lngNum >= -180 && lngNum <= 180;
      const addr = String(address || '').trim();

      if (!hasCoords && !addr) {
        toast('无法获取客户位置信息');
        return;
      }

      const cleanupHandlers = [];
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        cleanupHandlers.forEach(fn => fn());
      };

      if (!hasCoords) {
        this.fallbackToWeb({ name: customerName, address: addr }, cleanup);
        return;
      }

      const customer = { lat: latNum, lng: lngNum, name: customerName, address: addr };

      this.tryLaunchApp(customer);

      const fallbackTimer = setTimeout(() => {
        this.fallbackToWeb(customer, cleanup);
      }, this.config.timeout);
      cleanupHandlers.push(() => clearTimeout(fallbackTimer));

      const handlePageHide = () => {
        cleanup();
      };
      window.addEventListener('pagehide', handlePageHide);
      cleanupHandlers.push(() => window.removeEventListener('pagehide', handlePageHide));

      const handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') cleanup();
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      cleanupHandlers.push(() => document.removeEventListener('visibilitychange', handleVisibilityChange));
    },

    tryLaunchApp(customer) {
      const uri = this.buildAppUri(customer);
      try {
        window.location.href = uri;
      } catch (error) {
        console.error('调起高德地图失败:', error);
      }
    },

    fallbackToWeb(customer, cleanup) {
      const url = this.buildWebUrl(customer);
      const win = window.open(url, '_blank');
      if (!win) window.location.href = url;
      if (typeof cleanup === 'function') cleanup();
    },

    buildAppUri(customer) {
      const params = new URLSearchParams({
        sourceApplication: this.config.sourceApp,
        poiname: customer.name,
        lat: customer.lat,
        lon: customer.lng,
        dev: 0,
        style: 0
      });
      return `androidamap://navi?${params.toString()}`;
    },

    buildWebUrl(customer) {
      const params = new URLSearchParams();
      params.set('mode', this.config.navigationMode);
      params.set('callnative', '1');
      params.set('src', this.config.sourceApp);

      const myLoc = store.getState().myLocation;
      if (myLoc && Number.isFinite(myLoc.lng) && Number.isFinite(myLoc.lat)) {
        params.set('from', `${myLoc.lng},${myLoc.lat},我的位置`);
      }

      if (Number.isFinite(customer?.lat) && Number.isFinite(customer?.lng)) {
        params.set('coordinate', 'gaode');
        const safeName = String(customer?.name ?? '').replaceAll(',', ' ').trim();
        params.set('to', `${customer.lng},${customer.lat}${safeName ? `,${safeName}` : ''}`);
      } else {
        const addr = String(customer?.address ?? '').trim();
        params.set('to', addr);
      }

      return `https://uri.amap.com/navigation?${params.toString()}`;
    }
  };

  function showProfile(point) {
    const container = document.getElementById('profile-container');
    if (!container) return;

    NavigationModule.setActiveCustomer({
      lat: point.lat,
      lng: point.lng,
      name: point.name,
      address: point.add
    });
    
    let factorsHtml = '';
    if (point.factors && point.factors.length > 0) {
        factorsHtml = '<div class="factors-section"><h4>关键影响因子</h4><ul>';
        point.factors.forEach(f => {
            const factorValue = toNumber(f.value, 0);
            const barWidth = Math.min(Math.abs(factorValue) * 100, 100);
            const color = factorValue > 0 ? '#ff7f50' : '#87cefa';
            factorsHtml += `
                <li>
                    <span class="factor-name">${escapeHtml(f.name)}</span>
                    <div class="factor-bar-container">
                        <div class="factor-bar" style="width:${barWidth}%; background-color:${color}"></div>
                    </div>
                    <span class="factor-val">${factorValue.toFixed(2)}</span>
                </li>`;
        });
        factorsHtml += '</ul></div>';
    }

    container.innerHTML = `
      <div class="card-header">
        <span>${escapeHtml(point.name)}</span>
        <div class="card-header-actions">
          <button class="nav-header-button" type="button">添加途径点</button>
          <button class="close-button" type="button">×</button>
        </div>
      </div>
      <div class="card-body">
        <p><strong>类型:</strong><span class="profile-value">${escapeHtml(point.customerType)}</span></p>
        <p><strong>配送:</strong><span class="profile-value">${escapeHtml(point.deliveryType)}</span></p>
        <p><strong>需求:</strong><span class="profile-value">${escapeHtml(point.count)} 吨</span></p>
        <p><strong>部门:</strong><span class="profile-value">${escapeHtml(point.dep)}</span></p>
        <p><strong>地址:</strong><span class="profile-value profile-value-wrap">${escapeHtml(point.add)}</span></p>
        ${factorsHtml}
      </div>
      <div class="card-footer">
        <button class="nav-button" data-lat="${point.lat}" data-lng="${point.lng}" data-name="${escapeHtml(point.name)}">
          <span class="nav-icon">📍</span>
          <span>导航</span>
        </button>
      </div>
    `;
    
    container.style.display = 'flex';
    
    // Reset to hidden initially to avoid jump
    container.style.transform = 'translateY(100%)';
    
    requestAnimationFrame(() => {
        container.style.transform = 'translateY(0)';
        container.classList.add('active');
    });

    container.querySelector('.close-button').onclick = closeProfile;
    
    // Bind navigation button event
    const navButton = container.querySelector('.nav-button');
    if (navButton) {
      navButton.addEventListener('click', () => {
        NavigationModule.previewToDestination({
          lat: point.lat,
          lng: point.lng,
          name: point.name,
          address: point.add
        });
      });
    }

    const navHeaderButton = container.querySelector('.nav-header-button');
    if (navHeaderButton) {
      navHeaderButton.addEventListener('click', () => {
        NavigationModule.addToWaypoints({
          lat: point.lat,
          lng: point.lng,
          name: point.name,
          address: point.add
        });
      });
    }
  }

  function performSearch() {
    if (!dom.searchInput) return;
    const keyword = dom.searchInput.value.trim();
    const minDemand = parseFloat(dom.minDemand ? dom.minDemand.value : 0) || 0;
    const maxDemand = parseFloat(dom.maxDemand ? dom.maxDemand.value : Infinity) || Infinity;
    const prevFilters = store.getState().filters;
    if (minDemand !== prevFilters.minDemand || maxDemand !== prevFilters.maxDemand) {
      setFilters({ minDemand, maxDemand });
    }

    if (!keyword) {
      store.setState({ search: resetSearchState('') });
      renderSearchCounter(null, null, false);
      return;
    }

    const state = store.getState();
    if (state.search.keyword !== keyword) {
      store.setState({ search: resetSearchState(keyword) });
    }

    const searchState = store.getState().search;
    let matches = searchState.matches;
    if (!Array.isArray(matches) || matches.length === 0) {
      matches = store.getState().filteredData.filter(p => p.name.includes(keyword));
    }

    if (matches.length === 0) {
      setSearchState({ keyword, matches: [], index: -1 });
      renderSearchCounter(0, 0, true);
      return;
    }

    const nextIndex = (searchState.index + 1) % matches.length;
    const target = matches[nextIndex];
    setSearchState({ keyword, matches, index: nextIndex });
    renderSearchCounter(nextIndex + 1, matches.length, false);

    map.setZoomAndCenter(CONFIG.map.searchZoomLevel, [target.lng, target.lat]);
    showProfile(target);
  }

})();
