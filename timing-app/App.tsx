import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, Alert,
  PermissionsAndroid, Platform, TextInput, StatusBar, SafeAreaView, ScrollView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RNBluetoothClassic from 'react-native-bluetooth-classic';

// ── Types ─────────────────────────────────────────────────────────────────────

type Rider      = { id: number; rider_no: string; name: string; team: string; category: string; };
type Mode       = 'start' | 'finish';
type Screen     = 'setup' | 'bt' | 'race';
type RaceSettings = { stage: number; category: string; };
type QueuedEvent  = { id: string; payload: Record<string, unknown>; savedAt: string; };
type FinishEntry  = { timestamp: string };
type OnTrackEntry = { key: string; rider: Rider; startTs: number; stage: number };
type DropItem     = { label: string; value: string };

// ── Storage keys ──────────────────────────────────────────────────────────────

const QUEUE_KEY     = '@timing_offline_queue';
const RIDERS_KEY    = '@timing_riders';
const CATS_KEY      = '@timing_categories';
const STAGE_CNT_KEY = '@timing_stage_count';
const ONTRACK_KEY   = '@timing_on_track';
const RECONNECT_MS  = 4000;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Device local time with milliseconds — e.g. '2026-06-03 02:25:44.123'
function toMysqlDatetime(d: Date): string {
  const p = (n: number, z = 2) => String(n).padStart(z, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Elapsed ms → MM:SS, or H:MM:SS past an hour.
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

// ── Inline Dropdown ───────────────────────────────────────────────────────────

function Dropdown({ label, items, value, onChange, disabled = false }: {
  label: string; items: DropItem[]; value: string;
  onChange: (v: string) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = items.find(i => i.value === value);
  return (
    <View>
      <TouchableOpacity
        style={[ds.btn, disabled && ds.btnDisabled]}
        onPress={() => { if (!disabled) setOpen(o => !o); }}
        activeOpacity={disabled ? 1 : 0.7}
      >
        <Text style={[ds.val, !selected && ds.placeholder]}>
          {selected ? selected.label : label}
        </Text>
        <Text style={ds.chev}>{open ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {open && (
        <View style={ds.list}>
          <ScrollView nestedScrollEnabled style={{ maxHeight: 200 }}>
            {items.length === 0
              ? <Text style={ds.empty}>No options (offline)</Text>
              : items.map(item => (
                <TouchableOpacity
                  key={item.value}
                  style={[ds.item, value === item.value && ds.itemActive]}
                  onPress={() => { onChange(item.value); setOpen(false); }}
                >
                  <Text style={[ds.itemTxt, value === item.value && ds.itemActiveTxt]}>
                    {item.label}
                  </Text>
                </TouchableOpacity>
              ))
            }
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const ds = StyleSheet.create({
  btn:          { flexDirection: 'row', alignItems: 'center', backgroundColor: '#16213e', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: '#2a2a4a' },
  btnDisabled:  { opacity: 0.5 },
  val:          { flex: 1, color: '#fff', fontSize: 14 },
  placeholder:  { color: '#555' },
  chev:         { color: '#888', fontSize: 11, marginLeft: 6 },
  list:         { backgroundColor: '#16213e', borderRadius: 8, borderWidth: 1, borderColor: '#2a2a4a', marginTop: 2, zIndex: 999 },
  item:         { padding: 12, borderBottomWidth: 1, borderBottomColor: '#1a2a3a' },
  itemActive:   { backgroundColor: '#0f3460' },
  itemTxt:      { color: '#ccc', fontSize: 14 },
  itemActiveTxt:{ color: '#fff', fontWeight: '600' },
  empty:        { padding: 12, color: '#555', fontSize: 13, textAlign: 'center' },
});

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [wsUrl, setWsUrl]         = useState('ws://realtimemaster.com:3000');
  const [wsConnected, setWsConn]  = useState(false);
  const [showSettings, setShowSt] = useState(false);
  const [mode, setMode]           = useState<Mode>('start');
  const [riders, setRiders]       = useState<Rider[]>([]);
  const [selectedRider, setSelected] = useState<Rider | null>(null);
  const [raceSettings, setSettings]  = useState<RaceSettings>({ stage: 1, category: '' });
  const [stageCount, setStageCount]  = useState(10);
  const [categories, setCategories]  = useState<string[]>([]);
  const [btDevices, setBtDevices]    = useState<any[]>([]);
  const [btConnected, setBtConn]     = useState(false);
  const [lastEvent, setLastEvent]    = useState('');
  const [screen, setScreen]          = useState<Screen>('setup');
  const [pendingCount, setPending]   = useState(0);
  const [isSyncing, setSyncing]      = useState(false);
  const [searchQuery, setSearch]     = useState('');
  const [pendingFinishes, setPendingFins] = useState<FinishEntry[]>([]);
  const [ridersSync, setRidersSync]    = useState('');
  const [onTrack, setOnTrack]          = useState<OnTrackEntry[]>([]);
  const [nowTick, setNowTick]          = useState(Date.now());

  const ws              = useRef<WebSocket | null>(null);
  const btDevice        = useRef<any>(null);
  const btSub           = useRef<any>(null);
  const wsUrlRef        = useRef(wsUrl);
  const reconnectTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnect = useRef(false);

  // BT listener reads latest state via ref — avoids stale closure
  const live = useRef({ selectedRider, mode, raceSettings, pendingFinishes });
  useEffect(() => {
    live.current = { selectedRider, mode, raceSettings, pendingFinishes };
  }, [selectedRider, mode, raceSettings, pendingFinishes]);

  // 1 s ticker drives the live runtime of riders on track (start mode only).
  useEffect(() => {
    if (mode !== 'start' || onTrack.length === 0) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [mode, onTrack.length]);

  // Persist on-track list so a crash/restart keeps the running clocks.
  // Skip until the initial load has hydrated, so we don't clobber stored data.
  const onTrackHydrated = useRef(false);
  useEffect(() => {
    if (!onTrackHydrated.current) { onTrackHydrated.current = true; return; }
    AsyncStorage.setItem(ONTRACK_KEY, JSON.stringify(onTrack)).catch(() => {});
  }, [onTrack]);

  const addToTrack = useCallback((rider: Rider, startTs: number, stage: number) => {
    setOnTrack(prev => [{ key: `${rider.id}-${startTs}`, rider, startTs, stage }, ...prev]);
  }, []);

  const removeFromTrack = useCallback((key: string) => {
    setOnTrack(prev => prev.filter(e => e.key !== key));
  }, []);

  useEffect(() => { wsUrlRef.current = wsUrl; }, [wsUrl]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const stageItems: DropItem[] = Array.from({ length: stageCount }, (_, i) => ({
    label: `Stage ${i + 1}`, value: String(i + 1),
  }));

  const categoryItems: DropItem[] = categories.map(c => ({ label: c, value: c }));

  const filteredRiders = searchQuery.trim()
    ? riders.filter(r =>
        String(r.name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(r.rider_no ?? '').includes(searchQuery))
    : riders;

  // ── Offline queue ─────────────────────────────────────────────────────────

  const readQueue = useCallback(async (): Promise<QueuedEvent[]> => {
    try { const raw = await AsyncStorage.getItem(QUEUE_KEY); return raw ? JSON.parse(raw) : []; }
    catch { return []; }
  }, []);

  const enqueue = useCallback(async (payload: Record<string, unknown>) => {
    const queue   = await readQueue();
    const updated = [...queue, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      payload, savedAt: new Date().toISOString(),
    }];
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(updated));
    setPending(updated.length);
    return updated.length;
  }, [readQueue]);

  const flushQueue = useCallback(async (socket: WebSocket) => {
    const queue = await readQueue();
    if (!queue.length) return;
    setSyncing(true);
    for (const e of queue) socket.send(JSON.stringify(e.payload));
    await AsyncStorage.removeItem(QUEUE_KEY);
    setPending(0); setSyncing(false);
    setLastEvent(`✅ Synced ${queue.length} offline event${queue.length !== 1 ? 's' : ''}`);
  }, [readQueue]);

  // ── Persist riders / categories to AsyncStorage for offline use ───────────

  const cacheRiders = useCallback((data: Rider[]) => {
    const ts = new Date().toLocaleTimeString();
    setRiders(data);
    setRidersSync(ts);
    AsyncStorage.setItem(RIDERS_KEY, JSON.stringify(data)).catch(() => {});
  }, []);

  const cacheCategories = useCallback((cats: string[]) => {
    setCategories(cats);
    AsyncStorage.setItem(CATS_KEY, JSON.stringify(cats)).catch(() => {});
  }, []);

  // ── Load all caches on first mount ────────────────────────────────────────

  useEffect(() => {
    AsyncStorage.multiGet([RIDERS_KEY, CATS_KEY, STAGE_CNT_KEY, QUEUE_KEY, ONTRACK_KEY])
      .then(([[, rRaw], [, cRaw], [, sRaw], [, qRaw], [, tRaw]]) => {
        if (rRaw) { const r = JSON.parse(rRaw); setRiders(r); setRidersSync('cached'); }
        if (cRaw)   setCategories(JSON.parse(cRaw));
        if (sRaw)   setStageCount(parseInt(sRaw) || 10);
        if (qRaw)   setPending(JSON.parse(qRaw).length);
        if (tRaw)   setOnTrack(JSON.parse(tRaw));
      }).catch(() => {});
  }, []);

  // ── WebSocket ─────────────────────────────────────────────────────────────

  const requestAllData = (socket: WebSocket) => {
    socket.send('get_race_settings');
    socket.send('get_race_info');
    socket.send('get_category_list');
    socket.send(JSON.stringify({ action: 'get_data' }));
  };

  const connectWs = useCallback(() => {
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    ws.current?.close();
    const socket = new WebSocket(wsUrlRef.current);

    socket.onopen = () => {
      setWsConn(true);
      requestAllData(socket);
      flushQueue(socket);
    };

    socket.onmessage = ({ data: raw }) => {
      try {
        const d = JSON.parse(raw);
        switch (d.type) {
          case 'riders_data':
            cacheRiders(d.data);
            break;
          case 'result_race_info': {
            const count = parseInt(d.data?.stages) || 10;
            setStageCount(count);
            AsyncStorage.setItem(STAGE_CNT_KEY, String(count)).catch(() => {});
            break;
          }
          case 'result_category_list':
            if (Array.isArray(d.data)) {
              cacheCategories(d.data.map((c: any) => c.category_name));
            }
            break;
          case 'result_race_setting':
            setSettings({ stage: d.data?.stage ?? 1, category: d.data?.category ?? '' });
            break;
          case 'set_stage_ok':
            setLastEvent(`✅ Stage ${d.stage} / ${d.category} saved to server`);
            break;
          case 'success':
            setLastEvent('✅ ' + d.message);
            break;
          case 'error':
            setLastEvent('❌ ' + d.message);
            break;
        }
      } catch {}
    };

    socket.onerror = () => setWsConn(false);
    socket.onclose = () => {
      if (ws.current !== socket) return;
      setWsConn(false);
      if (shouldReconnect.current)
        reconnectTimer.current = setTimeout(connectWs, RECONNECT_MS);
    };
    ws.current = socket;
  }, [flushQueue, cacheRiders, cacheCategories]);

  // ── Stage / category change (updates local + broadcasts if connected) ──────

  const onStageChange = useCallback((val: string) => {
    const stage = parseInt(val);
    setSettings(prev => {
      const next = { ...prev, stage };
      if (ws.current?.readyState === WebSocket.OPEN)
        ws.current.send(JSON.stringify({ action: 'set_stage', stage: next.stage, category: next.category }));
      return next;
    });
  }, []);

  const onCategoryChange = useCallback((val: string) => {
    setSettings(prev => {
      const next = { ...prev, category: val };
      if (ws.current?.readyState === WebSocket.OPEN)
        ws.current.send(JSON.stringify({ action: 'set_stage', stage: next.stage, category: next.category }));
      return next;
    });
  }, []);

  // ── Bluetooth ─────────────────────────────────────────────────────────────

  const requestBtPermissions = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    if (Platform.Version >= 31) {
      const res = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      return Object.values(res).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
    }
    const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    return res === PermissionsAndroid.RESULTS.GRANTED;
  };

  const loadPairedDevices = async () => {
    if (!await requestBtPermissions()) { Alert.alert('Bluetooth permission denied'); return; }
    try { setBtDevices(await RNBluetoothClassic.getBondedDevices()); }
    catch (e: any) { Alert.alert('Bluetooth error', e.message); }
  };

  const connectToBt = async (device: any) => {
    try {
      await device.connect({ delimiter: '\n' });
      btDevice.current = device;
      setBtConn(true);
      btSub.current = device.onDataReceived((ev: any) => {
        if ((ev.data ?? '').trim() === 'BEAM_BREAK') handleBeamBreak();
      });
      setScreen('race');
    } catch (e: any) { Alert.alert('Connection failed', e.message); }
  };

  const disconnectBt = async () => {
    btSub.current?.remove(); btSub.current = null;
    try { await btDevice.current?.disconnect(); } catch {}
    btDevice.current = null; setBtConn(false);
  };

  // ── Beam break ────────────────────────────────────────────────────────────

  const handleBeamBreak = () => {
    const { mode: m, raceSettings: rs, selectedRider: rider } = live.current;
    const startDate = new Date();
    const timestamp = toMysqlDatetime(startDate);

    if (m === 'finish') {
      setPendingFins(prev => [...prev, { timestamp }]);
      setLastEvent(`⚡ Beam at ${timestamp} — tap the finisher`);
      return;
    }

    if (!rider) { Alert.alert('No rider selected', 'Select a rider before the beam.'); return; }
    const payload: Record<string, unknown> = {
      action: 'insert_start_time', rider_id: rider.id, stage: rs.stage, start_time: timestamp,
    };
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(payload));
      setLastEvent(`🚦 START  #${rider.rider_no} ${rider.name}  @ ${timestamp}`);
    } else {
      enqueue(payload).then(n => setLastEvent(`📦 Offline (${n}): 🚦 #${rider.rider_no} ${rider.name}`));
    }
    addToTrack(rider, startDate.getTime(), rs.stage);
  };

  const assignFinish = useCallback((rider: Rider) => {
    const pf = live.current.pendingFinishes[0];
    if (!pf) return;
    const rs = live.current.raceSettings;
    const payload: Record<string, unknown> = {
      action: 'insert_stop_time', rider_id: rider.id,
      stage: rs.stage, category: rs.category || rider.category, stop_time: pf.timestamp,
    };
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(payload));
      setLastEvent(`🏁 FINISH  #${rider.rider_no} ${rider.name}  @ ${pf.timestamp}`);
    } else {
      enqueue(payload).then(n => setLastEvent(`📦 Offline (${n}): 🏁 #${rider.rider_no} ${rider.name}`));
    }
    setPendingFins(prev => prev.slice(1));
    setSelected(rider);
  }, [enqueue]);

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  useEffect(() => {
    shouldReconnect.current = true;
    connectWs();
    return () => {
      shouldReconnect.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      ws.current?.close();
      btSub.current?.remove();
    };
  }, [connectWs]);

  // ── SETUP SCREEN ──────────────────────────────────────────────────────────

  if (screen === 'setup') {
    return (
      <SafeAreaView style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

          {/* Title bar */}
          <View style={s.titleBar}>
            <Text style={s.title}>⏱ Race Timing</Text>
            <TouchableOpacity style={s.gearBtn} onPress={() => setShowSt(v => !v)}>
              <Text style={s.gearTxt}>⚙</Text>
            </TouchableOpacity>
          </View>

          {/* Connection status */}
          <View style={[s.connBar, wsConnected ? s.connBarOn : s.connBarOff]}>
            <View style={[s.dot, wsConnected ? s.dotGreen : s.dotRed]} />
            <Text style={s.connTxt}>
              {wsConnected ? 'Server connected' : 'Offline — auto-retry 4 s'}
            </Text>
          </View>

          {/* Hidden settings (server URL) */}
          {showSettings && (
            <View style={s.settingsPanel}>
              <Text style={s.label}>Server URL</Text>
              <TextInput style={s.input} value={wsUrl} onChangeText={setWsUrl}
                placeholder="ws://realtimemaster.com:3000" placeholderTextColor="#555"
                autoCapitalize="none" keyboardType="url" />
              <TouchableOpacity style={s.btn} onPress={() => {
                shouldReconnect.current = true;
                connectWs();
                setShowSt(false);
              }}>
                <Text style={s.btnText}>Connect</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Stage */}
          <Text style={s.label}>Stage</Text>
          <Dropdown
            label="Select stage…"
            items={stageItems}
            value={String(raceSettings.stage)}
            onChange={onStageChange}
          />

          {/* Category */}
          <Text style={s.label}>Category</Text>
          <Dropdown
            label="Select category…"
            items={categoryItems}
            value={raceSettings.category}
            onChange={onCategoryChange}
            disabled={categoryItems.length === 0}
          />

          {/* Mode */}
          <Text style={s.label}>Device Mode</Text>
          <View style={s.modeRow}>
            {(['start', 'finish'] as Mode[]).map(m => (
              <TouchableOpacity key={m} style={[s.modeBtn, mode === m && s.modeBtnOn]} onPress={() => setMode(m)}>
                <Text style={[s.modeTxt, mode === m && s.modeTxtOn]}>
                  {m === 'start' ? '🚦 START' : '🏁 FINISH'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Offline cache status */}
          <View style={s.cacheBox}>
            <Text style={s.cacheTitle}>Offline Cache</Text>
            <View style={s.cacheRow}>
              <Text style={s.cacheItem}>
                {riders.length > 0
                  ? `✓ ${riders.length} riders${ridersSync ? `  ·  ${ridersSync}` : ''}`
                  : '✗ No riders cached'}
              </Text>
              <Text style={s.cacheItem}>
                {categories.length > 0
                  ? `✓ ${categories.length} categories`
                  : '✗ No categories cached'}
              </Text>
            </View>
            {wsConnected && (
              <TouchableOpacity style={[s.btn, s.btnRefresh]} onPress={() => {
                if (ws.current?.readyState === WebSocket.OPEN) requestAllData(ws.current);
              }}>
                <Text style={s.btnText}>📥  Download / Refresh for Offline</Text>
              </TouchableOpacity>
            )}
            {!wsConnected && riders.length === 0 && (
              <Text style={s.cacheWarn}>Connect to server at least once to cache riders.</Text>
            )}
          </View>

          {/* Pending offline events */}
          {pendingCount > 0 && (
            <View style={s.offlineBanner}>
              <Text style={s.offlineTxt}>
                📦 {pendingCount} event{pendingCount !== 1 ? 's' : ''} queued offline
                {wsConnected ? ' — will sync automatically' : ''}
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={[s.btn, s.btnAccent, { marginTop: 12, marginBottom: 32 }]}
            onPress={() => { setScreen('bt'); loadPairedDevices(); }}
          >
            <Text style={s.btnText}>Next: Bluetooth →</Text>
          </TouchableOpacity>

        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── BLUETOOTH SCREEN ──────────────────────────────────────────────────────

  if (screen === 'bt') {
    return (
      <SafeAreaView style={s.container}>
        <TouchableOpacity onPress={() => setScreen('setup')} style={s.backBtn}>
          <Text style={s.backTxt}>← Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Connect Bluetooth</Text>
        <Text style={s.muted}>Pair HC-05/HC-06 in Android Settings first.</Text>
        <TouchableOpacity style={s.btn} onPress={loadPairedDevices}>
          <Text style={s.btnText}>Refresh Paired Devices</Text>
        </TouchableOpacity>
        <FlatList data={btDevices} keyExtractor={i => i.address} style={{ marginTop: 12 }}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.deviceItem} onPress={() => connectToBt(item)}>
              <Text style={s.deviceName}>{item.name || 'Unknown'}</Text>
              <Text style={s.deviceAddr}>{item.address}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text style={s.muted}>No paired devices found.</Text>}
        />
      </SafeAreaView>
    );
  }

  // ── RACE SCREEN ───────────────────────────────────────────────────────────

  const isFinish   = mode === 'finish';
  const hasBeam    = isFinish && pendingFinishes.length > 0;
  const queuedMore = pendingFinishes.length - 1;

  return (
    <SafeAreaView style={s.container}>

      {/* Header */}
      <View style={s.raceHeader}>
        <TouchableOpacity onPress={() => { disconnectBt(); setScreen('bt'); }}>
          <Text style={s.backTxt}>← BT</Text>
        </TouchableOpacity>
        <Text style={s.raceMode}>{isFinish ? '🏁 FINISH' : '🚦 START'}</Text>
        <View style={s.statusDots}>
          <View style={[s.dot, btConnected ? s.dotGreen : s.dotRed]} />
          <View style={[s.dot, wsConnected ? s.dotGreen : s.dotRed]} />
        </View>
        <Text style={s.stagePill}>S{raceSettings.stage} {raceSettings.category ? `· ${raceSettings.category}` : ''}</Text>
      </View>

      {/* Sync bar */}
      {pendingCount > 0 && (
        <View style={s.syncBar}>
          <Text style={s.syncBarTxt}>
            {isSyncing ? '⏳ Syncing…' : `📦 ${pendingCount} offline${wsConnected ? '' : ' · no server'}`}
          </Text>
          {wsConnected && !isSyncing && (
            <TouchableOpacity style={s.syncNowBtn} onPress={() => ws.current && flushQueue(ws.current)}>
              <Text style={s.syncNowTxt}>Sync now</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* FINISH — beam hit banner */}
      {hasBeam && (
        <View style={s.beamBanner}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={s.beamTime}>{pendingFinishes[0].timestamp}</Text>
              {queuedMore > 0 && (
                <View style={s.queueBadge}>
                  <Text style={s.queueBadgeTxt}>+{queuedMore} more</Text>
                </View>
              )}
            </View>
            <Text style={s.beamSub}>
              {queuedMore > 0
                ? `⚡ ${pendingFinishes.length} beams queued — tap riders in crossing order`
                : '⚡ Beam hit — tap the finisher below'}
            </Text>
          </View>
          <TouchableOpacity style={s.discardBtn} onPress={() => setPendingFins(prev => prev.slice(1))}>
            <Text style={s.discardTxt}>Discard</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* FINISH — waiting */}
      {isFinish && !hasBeam && (
        <View style={s.waitBanner}>
          <Text style={s.waitTxt}>Waiting for beam sensor…</Text>
        </View>
      )}

      {/* START — selected rider */}
      {!isFinish && selectedRider && (
        <View style={s.readyBox}>
          <Text style={s.readyLabel}>Ready</Text>
          <Text style={s.readyName}>#{selectedRider.rider_no} {selectedRider.name}</Text>
        </View>
      )}

      {/* START — riders on track with live runtime */}
      {!isFinish && onTrack.length > 0 && (
        <View style={s.trackCard}>
          <Text style={s.trackTitle}>🚴 On Track · {onTrack.length}</Text>
          <ScrollView style={{ maxHeight: 170 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {onTrack.map(e => (
              <View key={e.key} style={s.trackRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.trackName} numberOfLines={1}>
                    #{e.rider.rider_no ?? ''}  {e.rider.name ?? ''}
                  </Text>
                  <Text style={s.trackMeta}>S{e.stage}</Text>
                </View>
                <Text style={s.trackTimer}>{fmtElapsed(nowTick - e.startTs)}</Text>
                <TouchableOpacity
                  style={s.trackRemove}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={() => removeFromTrack(e.key)}
                >
                  <Text style={s.trackRemoveTxt}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Search */}
      <TextInput style={s.searchInput} value={searchQuery} onChangeText={setSearch}
        placeholder={`Search ${riders.length} riders…`} placeholderTextColor="#555" />

      {/* Rider list */}
      <FlatList
        data={filteredRiders}
        keyExtractor={item => String(item.id)}
        style={s.riderList}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          const isSel = selectedRider?.id === item.id;
          return (
            <TouchableOpacity
              style={[s.riderItem, isSel && s.riderItemSel, hasBeam && s.riderItemAssign]}
              onPress={() => {
                if (isFinish && hasBeam) assignFinish(item);
                else if (!isFinish)      setSelected(item);
              }}
              activeOpacity={!isFinish || hasBeam ? 0.65 : 1}
            >
              <Text style={[s.riderName, isSel && s.riderNameSel]}>
                #{item.rider_no ?? ''}  {item.name ?? ''}
              </Text>
              <Text style={s.riderMeta}>{item.team ?? ''}  ·  {item.category ?? ''}</Text>
            </TouchableOpacity>
          );
        }}
      />

      {/* Event log */}
      <View style={s.eventBox}>
        <Text style={s.eventTxt}>
          {lastEvent || (isFinish ? 'Waiting for beam…' : 'Select a rider, then wait for beam…')}
        </Text>
      </View>

      <TouchableOpacity style={[s.btn, s.btnGray]} onPress={handleBeamBreak}>
        <Text style={s.btnText}>Manual Trigger (Test)</Text>
      </TouchableOpacity>

    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#1a1a2e', padding: 16 },
  // Setup
  titleBar:       { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  title:          { flex: 1, fontSize: 26, fontWeight: 'bold', color: '#e2e2e2', textAlign: 'center' },
  gearBtn:        { padding: 6 },
  gearTxt:        { fontSize: 22, color: '#666' },
  connBar:        { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 8, padding: 10, marginBottom: 4 },
  connBarOn:      { backgroundColor: '#0a2a0a' },
  connBarOff:     { backgroundColor: '#16213e' },
  connTxt:        { color: '#aaa', fontSize: 13, flex: 1 },
  settingsPanel:  { backgroundColor: '#0d1b2a', borderRadius: 10, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#2a3a4a' },
  label:          { color: '#aaa', fontSize: 12, marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 },
  muted:          { color: '#666', fontSize: 13 },
  input:          { backgroundColor: '#16213e', color: '#fff', borderRadius: 8, padding: 12, fontSize: 14, borderWidth: 1, borderColor: '#2a2a4a' },
  dot:            { width: 10, height: 10, borderRadius: 5 },
  dotGreen:       { backgroundColor: '#4caf50' },
  dotRed:         { backgroundColor: '#f44336' },
  btn:            { backgroundColor: '#0f3460', borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 10 },
  btnAccent:      { backgroundColor: '#e94560' },
  btnGray:        { backgroundColor: '#2a2a4a', marginBottom: 6 },
  btnRefresh:     { backgroundColor: '#0a3a4a', marginTop: 8 },
  btnText:        { color: '#fff', fontSize: 15, fontWeight: '600' },
  modeRow:        { flexDirection: 'row', gap: 8, marginTop: 4 },
  modeBtn:        { flex: 1, borderRadius: 8, padding: 14, alignItems: 'center', backgroundColor: '#16213e', borderWidth: 2, borderColor: '#2a2a4a' },
  modeBtnOn:      { borderColor: '#e94560', backgroundColor: '#2a0a14' },
  modeTxt:        { color: '#666', fontSize: 16, fontWeight: '700' },
  modeTxtOn:      { color: '#e94560' },
  cacheBox:       { backgroundColor: '#16213e', borderRadius: 10, padding: 14, marginTop: 14 },
  cacheTitle:     { color: '#888', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  cacheRow:       { gap: 4 },
  cacheItem:      { color: '#ccc', fontSize: 13 },
  cacheWarn:      { color: '#f0a500', fontSize: 12, marginTop: 8 },
  offlineBanner:  { backgroundColor: '#2a1f08', borderRadius: 8, padding: 10, marginTop: 10 },
  offlineTxt:     { color: '#f0a500', fontSize: 13, textAlign: 'center' },
  backBtn:        { marginBottom: 8 },
  backTxt:        { color: '#e94560', fontSize: 15 },
  deviceItem:     { backgroundColor: '#16213e', borderRadius: 8, padding: 14, marginBottom: 8 },
  deviceName:     { color: '#fff', fontSize: 16, fontWeight: '600' },
  deviceAddr:     { color: '#888', fontSize: 12, marginTop: 2 },
  // Race
  raceHeader:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  raceMode:       { flex: 1, color: '#fff', fontSize: 18, fontWeight: '700', textAlign: 'center' },
  statusDots:     { flexDirection: 'row', gap: 5 },
  stagePill:      { backgroundColor: '#16213e', color: '#aaa', fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, maxWidth: 120 },
  syncBar:        { flexDirection: 'row', alignItems: 'center', backgroundColor: '#2a1f08', borderRadius: 8, padding: 10, marginBottom: 4, gap: 8 },
  syncBarTxt:     { flex: 1, color: '#f0a500', fontSize: 12 },
  syncNowBtn:     { backgroundColor: '#f0a500', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  syncNowTxt:     { color: '#1a1a2e', fontSize: 12, fontWeight: '700' },
  beamBanner:     { flexDirection: 'row', alignItems: 'center', backgroundColor: '#2a1e00', borderWidth: 2, borderColor: '#f0a500', borderRadius: 10, padding: 12, marginBottom: 6 },
  beamTime:       { color: '#f0a500', fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
  beamSub:        { color: '#c88800', fontSize: 12, marginTop: 2 },
  discardBtn:     { backgroundColor: '#3a2a00', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 },
  discardTxt:     { color: '#f0a500', fontSize: 12, fontWeight: '600' },
  queueBadge:     { backgroundColor: '#f0a500', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  queueBadgeTxt:  { color: '#1a1a2e', fontSize: 11, fontWeight: '700' },
  waitBanner:     { backgroundColor: '#16213e', borderRadius: 8, padding: 10, marginBottom: 6, alignItems: 'center' },
  waitTxt:        { color: '#555', fontSize: 13 },
  readyBox:       { backgroundColor: '#0a2a0a', borderRadius: 8, padding: 12, marginBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 10 },
  readyLabel:     { color: '#4caf50', fontSize: 13 },
  readyName:      { color: '#4caf50', fontSize: 17, fontWeight: '700', flex: 1 },
  trackCard:      { backgroundColor: '#0d1b2a', borderRadius: 10, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: '#1f3a5a' },
  trackTitle:     { color: '#4aa3df', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
  trackRow:       { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#16213e', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 5 },
  trackName:      { color: '#fff', fontSize: 14, fontWeight: '600' },
  trackMeta:      { color: '#5c7a99', fontSize: 11, marginTop: 1 },
  trackTimer:     { color: '#4caf50', fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'], letterSpacing: 0.5 },
  trackRemove:    { backgroundColor: '#2a2a4a', borderRadius: 6, width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  trackRemoveTxt: { color: '#999', fontSize: 14, fontWeight: '700' },
  searchInput:    { backgroundColor: '#16213e', color: '#fff', borderRadius: 8, padding: 10, fontSize: 14, borderWidth: 1, borderColor: '#2a2a4a', marginBottom: 6 },
  riderList:      { flex: 1 },
  riderItem:      { backgroundColor: '#16213e', borderRadius: 8, padding: 12, marginBottom: 5, borderWidth: 2, borderColor: 'transparent' },
  riderItemSel:   { borderColor: '#e94560', backgroundColor: '#2a0a14' },
  riderItemAssign:{ borderColor: '#f0a500', backgroundColor: '#1e1600' },
  riderName:      { color: '#fff', fontSize: 15, fontWeight: '600' },
  riderNameSel:   { color: '#e94560' },
  riderMeta:      { color: '#666', fontSize: 12, marginTop: 2 },
  eventBox:       { backgroundColor: '#16213e', borderRadius: 8, padding: 12, marginVertical: 6, minHeight: 48, justifyContent: 'center' },
  eventTxt:       { color: '#ccc', fontSize: 13, textAlign: 'center' },
});
