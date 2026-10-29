(() => {
  'use strict';
  const C = window.COMMUTE_CONFIG;
  const LS_KEY = 'commute.serviceKey';
  const LS_TT = 'commute.timetable.v1';
  const REFRESH_MS = 30000;
  const HOLIDAYS = new Set(C.holidays || []);
  const $ = (s) => document.querySelector(s);

  // ---------- 인증키 (이 브라우저 localStorage에만 저장) ----------
  (function importKeyFromHash() {
    const m = location.hash.match(/key=([^&]+)/);
    if (m) {
      localStorage.setItem(LS_KEY, decodeURIComponent(m[1]).trim());
      history.replaceState(null, '', location.pathname + location.search);
    }
  })();
  const getKey = () => (localStorage.getItem(LS_KEY) || '').trim();
  const keyParam = () => { const k = getKey(); return k.includes('%') ? k : encodeURIComponent(k); };

  // ---------- 상태 ----------
  const params = new URLSearchParams(location.search);
  let dir = (params.get('dir') === 'work' || params.get('dir') === 'home')
    ? params.get('dir')
    : (new Date().getHours() < C.switchHour ? 'work' : 'home');
  let dayOverride = null;
  let busData = { work: null, home: null };
  let busFetchedAt = { work: 0, home: 0 };
  let busError = { work: '', home: '' };
  let timetable = null; // 아래 시간 유틸 정의 후 로드
  let ttSource = 'embedded';

  // ---------- 시간 유틸 ----------
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fmt = (mins) => { const m = Math.round(mins); return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`; };
  function dayTypeOf(d) {
    if (d.getDay() === 0 || HOLIDAYS.has(ymd(d))) return '3';
    if (d.getDay() === 6) return '2';
    return '1';
  }
  const DAY_LABEL = { '1': '평일', '2': '토요일', '3': '일·공휴일' };
  function now() {
    const d = new Date();
    let mins = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    const serviceDay = new Date(d);
    if (d.getHours() < 3) { mins += 1440; serviceDay.setDate(serviceDay.getDate() - 1); }
    return { d, mins, dayType: dayOverride || dayTypeOf(serviceDay) };
  }

  // ---------- 지하철 시각표 ----------
  function parseCompact(s) {
    return (s || '').split(',').filter(Boolean).map((x) => {
      const [dep, arr, end] = x.split('|');
      return { dep: toMin(dep), arr: arr ? toMin(arr) : null, end };
    });
  }
  function loadEmbeddedTT() {
    const T = window.COMMUTE_TT;
    const out = { updated: T.updated, work: {}, home: {} };
    for (const k of ['work', 'home']) for (const d of ['1', '2', '3']) out[k][d] = parseCompact(T[k][d]);
    return out;
  }
  timetable = loadEmbeddedTT();
  async function fetchStation(scode) {
    const url = `https://apis.data.go.kr/B551542/trainTime/getTrainTime?serviceKey=${keyParam()}&act=json&scode=${scode}&numOfRows=2000&pageNo=1`;
    const r = await fetch(url, { cache: 'no-store' });
    const j = await r.json();
    const items = [].concat((j.body && j.body.items && j.body.items.item) || []);
    if (!items.length) throw new Error('empty');
    return items;
  }
  function buildPairs(fromArr, toArr, updown) {
    const out = {};
    for (const d of ['1', '2', '3']) {
      const toMap = new Map(toArr.filter((o) => o.dayType === d && o.updown === updown).map((o) => [o.trainno, o.arrtime.slice(0, 5)]));
      out[d] = fromArr.filter((o) => o.dayType === d && o.updown === updown)
        .map((o) => `${o.arrtime.slice(0, 5)}|${toMap.get(o.trainno) || ''}|${o.endcode}`)
        .sort().join(',');
    }
    return out;
  }
  async function refreshTimetable() {
    const today = ymd(new Date());
    try {
      const cached = JSON.parse(localStorage.getItem(LS_TT) || 'null');
      if (cached && cached.work && cached.home) {
        applyTT(cached, 'cache');
        if (cached.fetched === today) return;
      }
    } catch (e) { /* ignore */ }
    if (!getKey()) return;
    try {
      const w = C.subway.work, h = C.subway.home;
      const [a, b] = await Promise.all([fetchStation(w.fromCode), fetchStation(w.toCode)]);
      const data = { fetched: today, updated: today, work: buildPairs(a, b, w.updown), home: buildPairs(b, a, h.updown) };
      if (!data.work['1'] || !data.home['1']) throw new Error('bad data');
      localStorage.setItem(LS_TT, JSON.stringify(data));
      applyTT(data, 'api');
      render();
    } catch (e) {
      console.warn('timetable refresh failed, using fallback', e);
    }
  }
  function applyTT(data, source) {
    const out = { updated: data.updated, work: {}, home: {} };
    for (const k of ['work', 'home']) for (const d of ['1', '2', '3']) out[k][d] = parseCompact(data[k][d]);
    timetable = out;
    ttSource = source;
  }
  function trainsFrom(kind, fromMin, count) {
    const n = now();
    const list = timetable[kind][n.dayType] || [];
    return list.filter((t) => t.dep >= fromMin).slice(0, count);
  }

  // ---------- 버스 실시간 ----------
  async function fetchBus(kind) {
    const stop = C.bus[kind];
    const url = `https://apis.data.go.kr/6260000/BusanBIMS/stopArrByBstopid?serviceKey=${keyParam()}&bstopid=${stop.stopId}`;
    const r = await fetch(url, { cache: 'no-store' });
    const txt = await r.text();
    const doc = new DOMParser().parseFromString(txt, 'text/xml');
    const code = doc.querySelector('resultCode');
    const authMsg = doc.querySelector('returnAuthMsg');
    if (authMsg) throw new Error(authMsg.textContent.includes('SERVICE_KEY') || /서비스키/.test(authMsg.textContent) ? '인증키 오류: ' + authMsg.textContent : authMsg.textContent);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (code && code.textContent !== '00') throw new Error(doc.querySelector('resultMsg')?.textContent || '응답 오류');
    return [...doc.querySelectorAll('item')].map((it) => Object.fromEntries([...it.children].map((c) => [c.tagName, c.textContent])));
  }
  async function refreshBus() {
    if (!getKey()) return;
    const kind = dir;
    setStatus('버스 정보 불러오는 중…');
    try {
      busData[kind] = await fetchBus(kind);
      busFetchedAt[kind] = Date.now();
      busError[kind] = '';
    } catch (e) {
      busError[kind] = e.message || String(e);
    }
    render();
  }

  // 지금 시각 기준으로 남은 분 (마지막 조회 후 흐른 시간만큼 차감)
  function busArrivals(kind) {
    const items = busData[kind] || [];
    const elapsed = (Date.now() - busFetchedAt[kind]) / 60000;
    return C.bus[kind].routes.map((no) => {
      const it = items.find((o) => o.lineno === no);
      const arr = [];
      if (it) {
        for (const i of ['1', '2']) {
          if (it['min' + i] !== undefined && it['min' + i] !== '') {
            arr.push({
              min: Math.max(0, Number(it['min' + i]) - elapsed),
              stations: it['station' + i],
              low: it['lowplate' + i] === '1',
              carno: it['carno' + i]
            });
          }
        }
      }
      return { lineno: no, arr };
    });
  }

  // ---------- 렌더 ----------
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const minText = (m) => (m < 1 ? '곧 도착' : `${Math.floor(m)}분`);
  const kakaoLink = (q) => `https://map.kakao.com/link/search/${encodeURIComponent(q)}`;

  function setStatus(msg, isErr) {
    const el = $('#status');
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
  }

  function busCard(kind, step, catchFn) {
    const stop = C.bus[kind];
    const rows = busArrivals(kind).map((b) => {
      if (!b.arr.length) {
        return `<div class="bus-row"><div class="lineno">${esc(b.lineno)}</div><div class="arr-none">도착 정보 없음 (운행 종료 또는 차고지 대기)</div></div>`;
      }
      const a = b.arr[0], nxt = b.arr[1];
      const n = now();
      const catchHtml = catchFn ? catchFn(a.min) : '';
      return `<div class="bus-row"><div class="lineno">${esc(b.lineno)}</div><div>
        <div class="arr-main ${a.min < 3 ? 'soon' : ''}">${minText(a.min)}<small>${fmt(n.mins + a.min)} · ${esc(a.stations)}정거장 전${a.low ? ' · 저상' : ''}</small></div>
        ${nxt ? `<div class="arr-next">다음 ${minText(nxt.min)} (${fmt(n.mins + nxt.min)}, ${esc(nxt.stations)}정거장 전)</div>` : ''}
        ${catchHtml}
      </div></div>`;
    }).join('');
    const err = busError[kind] ? `<div class="arr-none" style="color:var(--warn)">${esc(busError[kind])}</div>` : '';
    const noKey = !getKey() ? `<div class="arr-none">인증키를 설정하면 실시간 도착정보가 보여요. (⚙ 설정)</div>` : '';
    return `<section class="card">
      <div class="step">${step}</div>
      <h2><span class="tag bus">버스</span>${esc(stop.name)}</h2>
      <div class="sub">${esc(stop.towards)} · 정류장번호 ${esc(stop.ars)} · ${esc(stop.alight)}까지 약 ${stop.ride}분</div>
      ${noKey || err || rows}
    </section>`;
  }

  function trainCard(kind, step, list, matchSet, extraFn) {
    const s = C.subway[kind];
    const n = now();
    const items = list.map((t) => {
      const wait = t.dep - n.mins;
      return `<li class="${matchSet && matchSet.has(t.dep) ? 'match' : ''}">
        <span class="t-dep">${fmt(t.dep)}</span>
        <span class="t-in ${wait < 3 ? 'soon' : ''}">${wait < 1 ? '곧 출발' : Math.floor(wait) + '분 후'}</span>
        <span class="t-info">${esc(C.endNames[t.end] || t.end)}행${t.arr != null ? ` · ${esc(s.to)} ${fmt(t.arr)} 도착` : ''}${extraFn ? extraFn(t) : ''}</span>
      </li>`;
    }).join('');
    return `<section class="card">
      <div class="step">${step}</div>
      <h2><span class="tag metro">${esc(s.line)}</span>${esc(s.from)}역</h2>
      <div class="sub">${esc(s.towards)} · 시간표 기준 (${DAY_LABEL[n.dayType]})</div>
      ${items ? `<ul class="train-list">${items}</ul>` : '<div class="arr-none">오늘 남은 열차가 없어요.</div>'}
      <div class="links"><a href="${kakaoLink(s.from + '역 ' + s.line)}" target="_blank" rel="noopener">카카오맵 실시간 열차 위치 보기</a></div>
    </section>`;
  }

  function renderWork() {
    const b = C.bus.work, s = C.subway.work;
    const n = now();
    const reachTrain = (busMin) => {
      const at = n.mins + busMin + b.ride + C.transferWalk;
      return (timetable.work[n.dayType] || []).find((t) => t.dep >= at);
    };
    const match = new Set();
    let best = null;
    for (const r of busArrivals('work')) {
      for (const a of r.arr.slice(0, 1)) {
        if (a.min < b.walkFromOrigin) continue; // 집에서 걸어가도 못 탐
        const t = reachTrain(a.min);
        if (t) {
          match.add(t.dep);
          if (!best || t.dep < best.t.dep || (t.dep === best.t.dep && a.min > best.a.min)) best = { r, a, t };
        }
      }
    }
    const catchFn = (busMin) => {
      const t = reachTrain(busMin);
      return t ? `<div class="catch">→ 하단 ${fmt(t.dep)} 열차 → 서면 ${t.arr != null ? fmt(t.arr) : '?'} 도착</div>` : '';
    };
    const earliest = n.mins + b.walkFromOrigin + b.ride + C.transferWalk;
    const trains = trainsFrom('work', earliest, 6);

    let summary = '';
    if (best) {
      const leaveIn = best.a.min - b.walkFromOrigin;
      summary = `<section class="card summary">
        <div class="big">${esc(best.r.lineno)}번 버스 ${minText(best.a.min)} 후 → 하단 ${fmt(best.t.dep)} 열차 → 서면 ${best.t.arr != null ? fmt(best.t.arr) : '?'} 도착</div>
        <div class="sub">${leaveIn < 1 ? '지금 바로 나가야 해요' : `${Math.floor(leaveIn)}분 안에 집에서 출발 (정류장까지 도보 ${b.walkFromOrigin}분)`} · 12번출구까지 도보 약 ${s.exitWalk}분</div>
      </section>`;
    }
    $('#main').innerHTML = summary
      + busCard('work', '1단계', catchFn)
      + trainCard('work', '2단계 · 서면역 하차 후 12번출구', trains, match);
  }

  function renderHome() {
    const b = C.bus.home, s = C.subway.home;
    const n = now();
    const trains = trainsFrom('home', n.mins + s.walkFromOrigin, 6);
    const stopAt = (t) => (t.arr != null ? t.arr + C.transferWalk : null);
    const extra = (t) => (t.arr != null ? ` · 정류장 ${fmt(stopAt(t))}` : '');
    let summary = '';
    const first = trains[0];
    if (first && first.arr != null) {
      const arriveStop = stopAt(first);
      const buses = busArrivals('home').flatMap((r) => r.arr.map((a) => ({ no: r.lineno, at: n.mins + a.min })))
        .filter((x) => x.at >= arriveStop).sort((x, y) => x.at - y.at);
      const busTxt = buses.length
        ? `${esc(buses[0].no)}번 ${fmt(buses[0].at)} 도착 예정 (현재 실시간 기준)`
        : '그 시간대 버스는 아직 실시간 정보에 안 잡혀요. 하단 도착 후 아래 카드를 다시 확인하세요.';
      summary = `<section class="card summary">
        <div class="big">서면 ${fmt(first.dep)} 열차 (${Math.max(0, Math.floor(first.dep - n.mins))}분 후) → 하단 ${fmt(first.arr)} 도착</div>
        <div class="sub">하단역환승센터 정류장 약 ${fmt(arriveStop)} 도착 · ${busTxt}</div>
      </section>`;
    }
    $('#main').innerHTML = summary
      + trainCard('home', '1단계 · 12번출구에서 도보 약 ' + s.walkFromOrigin + '분', trains, null, extra)
      + busCard('home', `2단계 · ${esc(b.alight)} 하차, 집까지 도보 약 ${b.walkToDest}분`, null);
  }

  function render() {
    const isWork = dir === 'work';
    $('#dirBadge').textContent = isWork ? '출근' : '퇴근';
    $('#dirBadge').classList.toggle('home', !isWork);
    $('#fromPlace').textContent = isWork ? C.places.home : C.places.work;
    $('#toPlace').textContent = isWork ? C.places.work : C.places.home;
    const n = now();
    const db = $('#dayBadge');
    db.textContent = DAY_LABEL[n.dayType] + (dayOverride ? ' (수동)' : '');
    db.classList.toggle('override', !!dayOverride);
    document.title = (isWork ? '출근' : '퇴근') + ' 도착정보';
    if (isWork) renderWork(); else renderHome();

    if (!getKey()) {
      setStatus('인증키가 아직 없어요. 아래에서 설정해 주세요.', true);
    } else if (busError[dir]) {
      setStatus('버스 정보 오류: ' + busError[dir], true);
    } else if (busFetchedAt[dir]) {
      const sec = Math.floor((Date.now() - busFetchedAt[dir]) / 1000);
      const fd = new Date(busFetchedAt[dir]);
      setStatus(`버스 ${pad(fd.getHours())}:${pad(fd.getMinutes())}:${pad(fd.getSeconds())} 갱신 (${sec}초 전) · 30초마다 자동 갱신`);
    }
    $('#ttInfo').textContent = `지하철 시각표: ${ttSource === 'api' || ttSource === 'cache' ? 'API에서 ' + timetable.updated + ' 받음' : '내장본(' + timetable.updated + ')'}`;
  }

  // ---------- 설정 화면 ----------
  function openSetup(force) {
    const box = $('#setup');
    box.hidden = false;
    $('#keyExtra').hidden = !getKey();
    $('#keyInput').value = '';
    $('#keyInput').placeholder = getKey() ? '저장된 키 있음 (바꾸려면 새 키 붙여넣기)' : '일반 인증키 붙여넣기';
    $('#setupMsg').textContent = '';
    if (force) box.scrollIntoView({ behavior: 'smooth' });
  }
  $('#saveKeyBtn').onclick = async () => {
    const v = $('#keyInput').value.trim();
    if (!v) { $('#setupMsg').textContent = '키를 붙여넣어 주세요.'; return; }
    localStorage.setItem(LS_KEY, v);
    $('#setupMsg').textContent = '저장했어요. 확인 중…';
    busError[dir] = '';
    await refreshBus();
    if (busError[dir]) { $('#setupMsg').textContent = '키 확인 실패: ' + busError[dir] + ' (새로 발급한 키는 활성화까지 시간이 걸릴 수 있어요)'; return; }
    $('#setupMsg').textContent = '완료! 버스 정보가 정상적으로 들어와요.';
    $('#keyExtra').hidden = false;
    refreshTimetable();
  };
  $('#showKeyBtn').onclick = () => { const i = $('#keyInput'); i.type = i.type === 'password' ? 'text' : 'password'; };
  $('#deleteKeyBtn').onclick = () => {
    if (!confirm('이 기기에서 인증키를 지울까요?')) return;
    localStorage.removeItem(LS_KEY);
    busData = { work: null, home: null };
    busFetchedAt = { work: 0, home: 0 };
    openSetup();
    render();
  };
  $('#copyLinkBtn').onclick = async () => {
    const link = location.origin + location.pathname + '#key=' + encodeURIComponent(getKey());
    try { await navigator.clipboard.writeText(link); $('#setupMsg').textContent = '복사했어요. 나에게만 보내서 휴대폰에서 한 번 열어주세요.'; }
    catch (e) { prompt('이 링크를 복사하세요 (나에게만 보내기)', link); }
  };
  $('#closeSetupBtn').onclick = () => { $('#setup').hidden = true; };
  $('#settingsBtn').onclick = () => { const box = $('#setup'); if (box.hidden) openSetup(true); else box.hidden = true; };

  // ---------- 버튼 ----------
  $('#swapBtn').onclick = () => {
    dir = dir === 'work' ? 'home' : 'work';
    const u = new URL(location.href);
    u.searchParams.set('dir', dir);
    history.replaceState(null, '', u.pathname + u.search);
    render();
    if (!busFetchedAt[dir] || Date.now() - busFetchedAt[dir] > 15000) refreshBus();
  };
  $('#refreshBtn').onclick = () => refreshBus();
  const cycleDay = () => {
    const order = [null, '1', '2', '3'];
    dayOverride = order[(order.indexOf(dayOverride) + 1) % order.length];
    render();
  };
  $('#dayBadge').onclick = cycleDay;
  $('#dayBadge').onkeydown = (e) => { if (e.key === 'Enter') cycleDay(); };

  // ---------- 시작 ----------
  render();
  if (!getKey()) openSetup();
  refreshBus();
  refreshTimetable().then(render);
  setInterval(() => { if (document.visibilityState === 'visible') refreshBus(); }, REFRESH_MS);
  setInterval(() => { if (document.visibilityState === 'visible') render(); }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - busFetchedAt[dir] > 10000) refreshBus();
  });
})();
