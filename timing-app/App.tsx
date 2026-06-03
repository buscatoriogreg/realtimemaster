import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
  PermissionsAndroid,
  Platform,
  TextInput,
  StatusBar,
  SafeAreaView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RNBluetoothClassic from 'react-native-bluetooth-classic';

// ── Types ─────────────────────────────────────────────────────────────────────

type Rider = { id: number; rider_no: string; name: string; team: string; category: string; };
type Mode = 'start' | 'finish';
type Screen = 'setup' | 'bt' | 'race';
type RaceSettings = { stage: number; category: string; };

type QueuedEvent = {
  id: string;
  payload: Record<string, unknown>;
  savedAt: string; // ISO — shown in the queue viewer
};

// ── Constants ─────────────────────────────────────────────────────────────────

const QUEUE_KEY = '@timing_offline_queue';
const RECONNECT_DELAY_MS = 4000;

function toMysqlDatetime(d: Date): string {
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [wsUrl, setWsUrl] = useState('ws://realtimemaster.com:3000');
  const [wsConnected, setWsConnected] = useState(false);
  const [mode, setMode] = useState<Mode>('start');
  const [riders, setRiders] = useState<Rider[]>([]);
  const [selectedRider, setSelectedRider] = useState<Rider | null>(null);
  const [raceSettings, setRaceSettings] = useState<RaceSettings>({ stage: 1, category: '' });
  const [btDevices, setBtDevices] = useState<any[]>([]);
  const [btConnected, setBtConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState('');
  const [screen, setScreen] = useState<Screen>('setup');
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);

  const ws = useRef<WebSocket | null>(null);
  const btDevice = useRef<any>(null);
  const btSubscription = useRef<any>(null);
  const wsUrlRef = useRef(wsUrl);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnect = useRef(false);

  // Let the BT listener always read the latest values without re-subscribing
  const liveState = useRef({ selectedRider, mode, raceSettings });
  useEffect(() => {
    liveState.current = { selectedRider, mode, raceSettings };
  }, [selectedRider, mode, raceSettings]);

  // Keep wsUrl accessible inside stable callbacks
  useEffect(() => { wsUrlRef.current = wsUrl; }, [wsUrl]);

  // ── Offline queue ─────────────────────────────────────────────────────────

  const readQueue = useCallback(async (): Promise<QueuedEvent[]> => {
    try {
      const raw = await AsyncStorage.getItem(QUEUE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }, []);

  const enqueue = useCallback(async (payload: Record<string, unknown>) => {
    const queue = await readQueue();
    const entry: QueuedEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      payload,
      savedAt: new Date().toISOString(),
    };
    const updated = [...queue, entry];
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(updated));
    setPendingCount(updated.length);
    return updated.length;
  }, [readQueue]);

  // Flush all queued events over an open socket and clear local storage.
  const flushQueue = useCallback(async (socket: WebSocket) => {
    const queue = await readQueue();
    if (queue.length === 0) return;
    setIsSyncing(true);
    for (const entry of queue) {
      socket.send(JSON.stringify(entry.payload));
    }
    await AsyncStorage.removeItem(QUEUE_KEY);
    setPendingCount(0);
    setIsSyncing(false);
    setLastEvent(`✅ Synced ${queue.length} offline event${queue.length !== 1 ? 's' : ''} to server`);
  }, [readQueue]);

  // Load count on first mount so the badge is accurate after app restart
  useEffect(() => {
    readQueue().then(q => setPendingCount(q.length));
  }, [readQueue]);

  // ── WebSocket ─────────────────────────────────────────────────────────────

  // useCallback with [] — uses refs so it's safe to call from reconnect timer
  const connectWs = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    ws.current?.close();

    const socket = new WebSocket(wsUrlRef.current);

    socket.onopen = () => {
      setWsConnected(true);
      socket.send('get_race_settings');
      socket.send(JSON.stringify({ action: 'get_data' }));
      flushQueue(socket); // auto-sync any offline events
    };

    socket.onmessage = ({ data: raw }) => {
      try {
        const data = JSON.parse(raw);
        if (data.type === 'riders_data') {
          setRiders(data.data);
        } else if (data.type === 'result_race_setting') {
          setRaceSettings({ stage: data.data?.stage ?? 1, category: data.data?.category ?? '' });
        } else if (data.type === 'success') {
          setLastEvent('✅ ' + data.message);
        } else if (data.type === 'error') {
          setLastEvent('❌ ' + data.message);
        }
      } catch {}
    };

    socket.onerror = () => setWsConnected(false);

    socket.onclose = () => {
      // Only react to the socket we currently own
      if (ws.current !== socket) return;
      setWsConnected(false);
      if (shouldReconnect.current) {
        reconnectTimer.current = setTimeout(connectWs, RECONNECT_DELAY_MS);
      }
    };

    ws.current = socket;
  }, [flushQueue]); // flushQueue is stable (useCallback [])

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
    try {
      setBtDevices(await RNBluetoothClassic.getBondedDevices());
    } catch (e: any) {
      Alert.alert('Bluetooth error', e.message);
    }
  };

  const connectToBt = async (device: any) => {
    try {
      await device.connect({ delimiter: '\n' });
      btDevice.current = device;
      setBtConnected(true);
      btSubscription.current = device.onDataReceived((event: any) => {
        if ((event.data ?? '').trim() === 'BEAM_BREAK') handleBeamBreak();
      });
      setScreen('race');
    } catch (e: any) {
      Alert.alert('Connection failed', e.message);
    }
  };

  const disconnectBt = async () => {
    btSubscription.current?.remove();
    btSubscription.current = null;
    try { await btDevice.current?.disconnect(); } catch {}
    btDevice.current = null;
    setBtConnected(false);
  };

  // ── Beam break ────────────────────────────────────────────────────────────

  const handleBeamBreak = () => {
    const { selectedRider: rider, mode: m, raceSettings: rs } = liveState.current;
    if (!rider) { Alert.alert('No rider selected', 'Select a rider first.'); return; }

    const timestamp = toMysqlDatetime(new Date());
    const label = m === 'start' ? '🚦 START' : '🏁 FINISH';

    const payload: Record<string, unknown> =
      m === 'start'
        ? { action: 'insert_start_time', rider_id: rider.id, stage: rs.stage, start_time: timestamp }
        : { action: 'insert_stop_time', rider_id: rider.id, stage: rs.stage, category: rs.category || rider.category, stop_time: timestamp };

    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(payload));
      setLastEvent(`${label}  #${rider.rider_no} ${rider.name}  @ ${timestamp}`);
    } else {
      // No connection — queue locally, will sync on reconnect
      enqueue(payload).then(count => {
        setLastEvent(`📦 Saved offline (${count} pending): ${label}  #${rider.rider_no} ${rider.name}`);
      });
    }
  };

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      shouldReconnect.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      ws.current?.close();
      btSubscription.current?.remove();
    };
  }, []);

  // ── Setup screen ──────────────────────────────────────────────────────────

  if (screen === 'setup') {
    return (
      <SafeAreaView style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <Text style={s.title}>⏱ Race Timing</Text>

        <Text style={s.label}>Server URL</Text>
        <TextInput
          style={s.input}
          value={wsUrl}
          onChangeText={setWsUrl}
          placeholder="ws://realtimemaster.com:3000"
          placeholderTextColor="#555"
          autoCapitalize="none"
          keyboardType="url"
        />
        <TouchableOpacity
          style={s.btn}
          onPress={() => { shouldReconnect.current = true; connectWs(); }}
        >
          <Text style={s.btnText}>Connect to Server</Text>
        </TouchableOpacity>
        <View style={s.row}>
          <View style={[s.dot, wsConnected ? s.dotGreen : s.dotRed]} />
          <Text style={s.muted}>
            {wsConnected ? 'Connected' : 'Disconnected — auto-retry every 4 s'}
          </Text>
        </View>

        <Text style={s.label}>Device Mode</Text>
        <View style={s.row}>
          {(['start', 'finish'] as Mode[]).map(m => (
            <TouchableOpacity key={m} style={[s.modeBtn, mode === m && s.modeBtnOn]} onPress={() => setMode(m)}>
              <Text style={[s.modeTxt, mode === m && s.modeTxtOn]}>
                {m === 'start' ? '🚦 START' : '🏁 FINISH'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {wsConnected && (
          <View style={s.infoBox}>
            <Text style={s.infoTxt}>Stage {raceSettings.stage}  ·  Category: {raceSettings.category || '—'}</Text>
            <Text style={s.infoTxt}>{riders.length} riders loaded</Text>
          </View>
        )}

        {/* Offline queue badge — visible even without server connection */}
        {pendingCount > 0 && (
          <View style={s.offlineBanner}>
            <Text style={s.offlineTxt}>
              📦 {pendingCount} event{pendingCount !== 1 ? 's' : ''} stored offline
              {wsConnected ? ' — will sync on next screen' : ' — connect server to sync'}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[s.btn, s.btnAccent]}
          onPress={() => { setScreen('bt'); loadPairedDevices(); }}
        >
          <Text style={s.btnText}>Next: Bluetooth →</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── Bluetooth screen ──────────────────────────────────────────────────────

  if (screen === 'bt') {
    return (
      <SafeAreaView style={s.container}>
        <TouchableOpacity onPress={() => setScreen('setup')} style={s.backBtn}>
          <Text style={s.backTxt}>← Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Connect Bluetooth</Text>
        <Text style={s.muted}>Pair HC-05/HC-06 in Android Settings first, then refresh.</Text>
        <TouchableOpacity style={s.btn} onPress={loadPairedDevices}>
          <Text style={s.btnText}>Refresh Paired Devices</Text>
        </TouchableOpacity>
        <FlatList
          data={btDevices}
          keyExtractor={item => item.address}
          style={{ marginTop: 12 }}
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

  // ── Race screen ───────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={s.container}>
      <View style={s.raceHeader}>
        <TouchableOpacity onPress={() => { disconnectBt(); setScreen('bt'); }}>
          <Text style={s.backTxt}>← BT</Text>
        </TouchableOpacity>
        <Text style={s.raceMode}>{mode === 'start' ? '🚦 START' : '🏁 FINISH'}</Text>
        <View style={s.statusDots}>
          <View style={[s.dot, btConnected ? s.dotGreen : s.dotRed]} />
          <View style={[s.dot, wsConnected ? s.dotGreen : s.dotRed]} />
        </View>
        <Text style={s.muted}>S{raceSettings.stage}</Text>
      </View>

      {/* Sync bar — only shown when there are pending events */}
      {pendingCount > 0 && (
        <View style={s.syncBar}>
          <Text style={s.syncBarTxt}>
            {isSyncing
              ? '⏳ Syncing…'
              : `📦 ${pendingCount} offline${wsConnected ? '' : ' · no server'}`}
          </Text>
          {wsConnected && !isSyncing && (
            <TouchableOpacity
              style={s.syncNowBtn}
              onPress={() => ws.current && flushQueue(ws.current)}
            >
              <Text style={s.syncNowTxt}>Sync now</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <Text style={s.label}>Select Rider</Text>
      <FlatList
        data={riders}
        keyExtractor={item => String(item.id)}
        style={s.riderList}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[s.riderItem, selectedRider?.id === item.id && s.riderItemOn]}
            onPress={() => setSelectedRider(item)}
          >
            <Text style={[s.riderName, selectedRider?.id === item.id && s.riderNameOn]}>
              #{item.rider_no}  {item.name}
            </Text>
            <Text style={s.riderMeta}>{item.team}  ·  {item.category}</Text>
          </TouchableOpacity>
        )}
      />

      {selectedRider && (
        <View style={s.readyBox}>
          <Text style={s.readyLabel}>Ready</Text>
          <Text style={s.readyName}>#{selectedRider.rider_no} {selectedRider.name}</Text>
        </View>
      )}

      <View style={s.eventBox}>
        <Text style={s.eventTxt}>{lastEvent || 'Waiting for BEAM_BREAK…'}</Text>
      </View>

      <TouchableOpacity style={[s.btn, s.btnGray]} onPress={handleBeamBreak}>
        <Text style={s.btnText}>Manual Trigger (Test)</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#1a1a2e', padding: 16 },
  title:        { fontSize: 26, fontWeight: 'bold', color: '#e2e2e2', textAlign: 'center', marginBottom: 20 },
  label:        { color: '#aaa', fontSize: 12, marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 },
  muted:        { color: '#666', fontSize: 13 },
  input:        { backgroundColor: '#16213e', color: '#fff', borderRadius: 8, padding: 12, fontSize: 14, borderWidth: 1, borderColor: '#2a2a4a' },
  row:          { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  dot:          { width: 10, height: 10, borderRadius: 5 },
  dotGreen:     { backgroundColor: '#4caf50' },
  dotRed:       { backgroundColor: '#f44336' },
  btn:          { backgroundColor: '#0f3460', borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 10 },
  btnAccent:    { backgroundColor: '#e94560' },
  btnGray:      { backgroundColor: '#2a2a4a', marginBottom: 6 },
  btnText:      { color: '#fff', fontSize: 15, fontWeight: '600' },
  modeBtn:      { flex: 1, borderRadius: 8, padding: 14, alignItems: 'center', backgroundColor: '#16213e', borderWidth: 2, borderColor: '#2a2a4a' },
  modeBtnOn:    { borderColor: '#e94560', backgroundColor: '#2a0a14' },
  modeTxt:      { color: '#666', fontSize: 16, fontWeight: '700' },
  modeTxtOn:    { color: '#e94560' },
  infoBox:      { backgroundColor: '#16213e', borderRadius: 8, padding: 12, marginTop: 12, gap: 4 },
  infoTxt:      { color: '#ccc', fontSize: 13 },
  offlineBanner: { backgroundColor: '#2a1f08', borderRadius: 8, padding: 10, marginTop: 10 },
  offlineTxt:   { color: '#f0a500', fontSize: 13, textAlign: 'center' },
  backBtn:      { marginBottom: 8 },
  backTxt:      { color: '#e94560', fontSize: 15 },
  deviceItem:   { backgroundColor: '#16213e', borderRadius: 8, padding: 14, marginBottom: 8 },
  deviceName:   { color: '#fff', fontSize: 16, fontWeight: '600' },
  deviceAddr:   { color: '#888', fontSize: 12, marginTop: 2 },
  raceHeader:   { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  raceMode:     { flex: 1, color: '#fff', fontSize: 18, fontWeight: '700', textAlign: 'center' },
  statusDots:   { flexDirection: 'row', gap: 5 },
  syncBar:      { flexDirection: 'row', alignItems: 'center', backgroundColor: '#2a1f08', borderRadius: 8, padding: 10, marginBottom: 4, gap: 8 },
  syncBarTxt:   { flex: 1, color: '#f0a500', fontSize: 12 },
  syncNowBtn:   { backgroundColor: '#f0a500', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  syncNowTxt:   { color: '#1a1a2e', fontSize: 12, fontWeight: '700' },
  riderList:    { flex: 1, marginTop: 4 },
  riderItem:    { backgroundColor: '#16213e', borderRadius: 8, padding: 12, marginBottom: 6, borderWidth: 2, borderColor: 'transparent' },
  riderItemOn:  { borderColor: '#e94560', backgroundColor: '#2a0a14' },
  riderName:    { color: '#fff', fontSize: 15, fontWeight: '600' },
  riderNameOn:  { color: '#e94560' },
  riderMeta:    { color: '#666', fontSize: 12, marginTop: 2 },
  readyBox:     { backgroundColor: '#0a2a0a', borderRadius: 8, padding: 12, marginTop: 6, flexDirection: 'row', alignItems: 'center', gap: 10 },
  readyLabel:   { color: '#4caf50', fontSize: 13 },
  readyName:    { color: '#4caf50', fontSize: 17, fontWeight: '700', flex: 1 },
  eventBox:     { backgroundColor: '#16213e', borderRadius: 8, padding: 12, marginVertical: 8, minHeight: 52, justifyContent: 'center' },
  eventTxt:     { color: '#ccc', fontSize: 13, textAlign: 'center' },
});
