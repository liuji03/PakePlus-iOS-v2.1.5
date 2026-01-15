(function () {
  const CONFIG = {
    accessCodes: {
      all: '123456', 本级: '111111', 瑞安: '222222', 乐清: '333333',
      苍南: '444444', 平阳: '555555', 永嘉: '666666', 泰顺: '777777', 文成: '888888'
    },
    map: { center: [120.65, 28.01], zoom: 10, resizeEnable: true, searchZoomLevel: 16 },
    labels: {
      minZoomToShowLabel: 14,
      limit: 100, // Reduced for mobile performance
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
  let currentMarkers = []; 

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
    search: resetSearchState('')
  });

  const dom = {
    searchInput: document.getElementById('search-input'),
    searchCounter: document.getElementById('search-counter'),
    minDemand: document.getElementById('min-demand'),
    maxDemand: document.getElementById('max-demand'),
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
      initMap();
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

    const disCountry = new AMap.DistrictLayer.Province(CONFIG.districtLayer);
    disCountry.setMap(map);

    map.plugin(['AMap.Heatmap'], function () {
      heatmapInstance = new AMap.Heatmap(map, CONFIG.heatmap);
      allData = normalizeData(window.allHeatmapData || []);
      store.setState({ filters: getDefaultFilters(currentDep) });
      recomputeFilteredData();
    });

    map.on('zoomend', updateLabels);
    map.on('moveend', updateLabels);
    map.on('click', closeProfile);
    
    setupControls();
  }

  function setupControls() {
    // Search
    const searchBtn = document.getElementById('search-button');
    if(searchBtn) searchBtn.addEventListener('click', performSearch);
    if (dom.searchInput) {
      dom.searchInput.addEventListener('input', () => {
        const keyword = dom.searchInput.value.trim();
        store.setState({ search: resetSearchState(keyword) });
        renderSearchCounter(null, null, false);
      });
    }
    
    // Panel Toggles
    document.getElementById('filter-toggle-btn').addEventListener('click', () => togglePanel('filter-panel'));
    
    // Close Buttons
    document.querySelector('.close-panel-btn').addEventListener('click', () => closePanel('filter-panel'));

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
    
    if (currentMarkers.length > 0) {
        map.remove(currentMarkers);
        currentMarkers = [];
    }
    
    const zoom = map.getZoom();
    if (zoom < CONFIG.labels.minZoomToShowLabel) return;

    const bounds = map.getBounds();
    const visiblePoints = store.getState().filteredData.filter(p => bounds.contains([p.lng, p.lat]));
    const pointsToShow = visiblePoints.slice(0, CONFIG.labels.limit);

    pointsToShow.forEach(point => {
      let className = 'custom-label';
      if (point.customerType === '存量客户') className += ' existing-customer-label';
      else if (point.customerType === '流失客户') className += ' lost-customer-label';
      else if (point.customerType === '潜在客户') className += ' potential-customer-label';

      const content = `<div class="${className}">${escapeHtml(point.name)}</div>`;
      
      const marker = new AMap.Marker({
        position: [point.lng, point.lat],
        content: content,
        offset: new AMap.Pixel(0, -15),
        zIndex: 100,
        extData: point
      });
      
      marker.on('click', (e) => {
          e.originEvent.stopPropagation(); // Prevent map click
          showProfile(point);
      });
      marker.setMap(map);
      currentMarkers.push(marker);
    });
  }

  // Gesture Logic
  let gestureState = {
    startY: 0,
    startTranslate: 0,
    currentTranslate: 0,
    isDragging: false,
    peekTranslate: 0
  };

  function initProfileGestures() {
    const container = document.getElementById('profile-container');
    if (!container) return;

    const getTranslateY = () => {
        const style = window.getComputedStyle(container);
        const matrix = new WebKitCSSMatrix(style.transform);
        return matrix.m42;
    };

    container.addEventListener('touchstart', (e) => {
        if (!e.target.closest('.card-header') && !e.target.closest('.drag-handle-container')) return;
        
        gestureState.isDragging = true;
        gestureState.startY = e.touches[0].clientY;
        gestureState.startTranslate = getTranslateY();
        gestureState.currentTranslate = gestureState.startTranslate;
        
        container.classList.add('is-dragging');
    }, { passive: false });

    container.addEventListener('touchmove', (e) => {
        if (!gestureState.isDragging) return;
        if (e.cancelable) e.preventDefault();
        
        const deltaY = e.touches[0].clientY - gestureState.startY;
        let newTranslate = gestureState.startTranslate + deltaY;
        
        // Resistance
        if (newTranslate < 0) newTranslate *= 0.3;
        
        gestureState.currentTranslate = newTranslate;
        container.style.transform = `translateY(${newTranslate}px)`;
    }, { passive: false });

    container.addEventListener('touchend', (e) => {
        if (!gestureState.isDragging) return;
        gestureState.isDragging = false;
        container.classList.remove('is-dragging');
        
        const deltaY = gestureState.currentTranslate - gestureState.startTranslate;
        
        if (deltaY > 100) {
            closeProfile();
        } else if (deltaY < -50) {
            container.style.transform = `translateY(0)`;
        } else {
            const distToFull = Math.abs(gestureState.currentTranslate);
            const distToPeek = Math.abs(gestureState.currentTranslate - gestureState.peekTranslate);
            
            if (distToFull < distToPeek) {
                container.style.transform = `translateY(0)`;
            } else {
                container.style.transform = `translateY(${gestureState.peekTranslate}px)`;
            }
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
      lastNavAt: 0
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
        alert('无法获取客户位置信息');
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
      <div class="drag-handle-container">
        <div class="drag-handle-bar"></div>
      </div>
      <div class="card-header">
        <span>${escapeHtml(point.name)}</span>
        <div class="card-header-actions">
          <button class="nav-header-button" type="button">导航</button>
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
        const fullHeight = container.offsetHeight;
        const peekHeight = window.innerHeight * 0.45;
        
        let targetTranslate = 0;
        // Only peek if significantly taller than peek height
        if (fullHeight > peekHeight + 50) {
            targetTranslate = fullHeight - peekHeight;
        }
        
        gestureState.peekTranslate = targetTranslate;
        container.style.transform = `translateY(${targetTranslate}px)`;
        container.classList.add('active');
    });

    container.querySelector('.close-button').onclick = closeProfile;
    
    // Bind navigation button event
    const navButton = container.querySelector('.nav-button');
    if (navButton) {
      navButton.addEventListener('click', () => {
        NavigationModule.navigateToCustomer(point.lat, point.lng, point.name, point.add);
      });
    }

    const navHeaderButton = container.querySelector('.nav-header-button');
    if (navHeaderButton) {
      navHeaderButton.addEventListener('click', () => {
        NavigationModule.navigateToCustomer(point.lat, point.lng, point.name, point.add);
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
