import React, { useState, useEffect, useRef } from 'react';
import { Download, CheckCircle, Loader, AlertCircle, FolderOpen, Info, Shield, Key, Smartphone, Unlock } from 'lucide-react';

const MODES = [
  {
    id: 'noroot',
    icon: Unlock,
    label: 'No Root',
    badge: 'Recommended',
    badgeColor: 'bg-green-900 text-green-300',
    borderActive: 'border-green-500 bg-green-900/20',
    iconColor: 'text-green-400',
    desc: 'Works like iCareFone. Pulls DB via ADB, auto-extracts key.',
  },
  {
    id: 'root',
    icon: Shield,
    label: 'Root Mode',
    badge: 'Most Reliable',
    badgeColor: 'bg-blue-900 text-blue-300',
    borderActive: 'border-blue-500 bg-blue-900/20',
    iconColor: 'text-blue-400',
    desc: 'Requires Magisk/SuperSU. Works on all Android versions.',
  },
  {
    id: 'apk',
    icon: Smartphone,
    label: 'APK Mode',
    badge: 'Android ≤ 11',
    badgeColor: 'bg-slate-700 text-slate-300',
    borderActive: 'border-slate-400 bg-slate-700/30',
    iconColor: 'text-slate-300',
    desc: 'Legacy method. Blocked on Android 12+ rollback protection.',
  },
];

const STEPS = {
  noroot: [
    { label: 'Scanning device storage', detail: 'Finding msgstore.db.crypt15 on external storage' },
    { label: 'Pulling encrypted database', detail: 'adb pull /sdcard/Android/media/com.whatsapp/...' },
    { label: 'Extracting encryption key', detail: 'Trying run-as / shell methods automatically' },
    { label: 'Decrypting database', detail: 'AES-256-GCM decryption' },
  ],
  root: [
    { label: 'Verifying root access', detail: 'Checking su is available on device' },
    { label: 'Pulling encryption key', detail: 'su -c cp /data/data/com.whatsapp/files/key' },
    { label: 'Pulling encrypted database', detail: 'Pulling msgstore.db.crypt15 from device' },
    { label: 'Decrypting database', detail: 'AES-256-GCM decryption' },
  ],
  apk: [
    { label: 'Sideloading legacy APK', detail: 'Reinstalls WhatsApp v2.19.291 to enable backup' },
    { label: 'Triggering ADB backup', detail: 'Confirm "Back up my data" on phone' },
    { label: 'Extracting files from backup', detail: 'Pulling key + database from .ab archive' },
    { label: 'Decrypting database', detail: 'AES-256-GCM decryption' },
  ],
};

export default function Step4_ExtractAndroid({ transferData, next }) {
  const [mode, setMode] = useState('noroot');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [apkPath, setApkPath] = useState(null);
  const [manualKeyPath, setManualKeyPath] = useState(null);
  const [currentSubStep, setCurrentSubStep] = useState(-1);
  const [rootStatus, setRootStatus] = useState(null);
  const [needsManualKey, setNeedsManualKey] = useState(false);
  const [pendingCryptPath, setPendingCryptPath] = useState(null);
  const logRef = useRef(null);

  useEffect(() => {
    const unsub = window.electronAPI.on('adb:backup-progress', ({ percent, message }) => {
      setProgress(percent);
      setProgressMsg(message);
      addLog(message);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (mode === 'root' && rootStatus === null && transferData.deviceId) checkRoot();
  }, [mode]);

  function addLog(msg) {
    setLogs(prev => [...prev.slice(-200), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }

  async function checkRoot() {
    setRootStatus('checking');
    const r = await window.electronAPI.checkRoot(transferData.deviceId).catch(() => ({ hasRoot: false }));
    setRootStatus(r.hasRoot ? 'yes' : 'no');
  }

  const selectFile = async (setter, filters) => {
    const p = await window.electronAPI.selectFile(filters);
    if (p) setter(p);
  };

  async function runExtraction() {
    setRunning(true);
    setError(null);
    setNeedsManualKey(false);
    setLogs([]);
    setProgress(0);
    setCurrentSubStep(0);

    const { deviceId, appId } = transferData;

    try {
      let dbPath;

      if (mode === 'noroot') {
        addLog('Starting no-root extraction (iCareFone-style)...');
        addLog('Pulling database from external storage — no root required.');
        setCurrentSubStep(0);

        const result = await window.electronAPI.norootExtract(deviceId, appId, manualKeyPath);

        if (result.error) throw new Error(result.error);

        if (result.needsKey) {
          // Auto key extraction failed — ask user to provide key manually
          setPendingCryptPath(result.cryptPath);
          setNeedsManualKey(true);
          setRunning(false);
          addLog('⚠ Database pulled but key extraction failed automatically.');
          addLog('Please provide the key file manually to continue.');
          return;
        }

        setCurrentSubStep(3);
        dbPath = result.dbPath;
        addLog(`✓ Database decrypted: ${dbPath}`);

      } else if (mode === 'root') {
        addLog('Starting root extraction...');
        setCurrentSubStep(0);
        const rootCheck = await window.electronAPI.checkRoot(deviceId);
        if (!rootCheck.hasRoot) throw new Error('Root not available. Tap Grant if Magisk prompts on your phone.');
        addLog('✓ Root confirmed.');
        setCurrentSubStep(1);

        const result = await window.electronAPI.rootExtractDecrypt(deviceId, appId);
        if (result.error) throw new Error(result.error);
        setCurrentSubStep(3);
        dbPath = result.dbPath;
        addLog(`✓ Database decrypted: ${dbPath}`);

      } else if (mode === 'apk') {
        if (!apkPath) throw new Error('Please select the legacy WhatsApp APK first.');
        addLog('Installing legacy APK...');
        setCurrentSubStep(0);

        const installResult = await window.electronAPI.installApk(deviceId, apkPath, appId);
        if (installResult.error) throw new Error(installResult.error);
        addLog('✓ APK installed.');
        setCurrentSubStep(1);

        addLog('Running ADB backup — tap "Back up my data" on your phone...');
        const result = await window.electronAPI.backupExtractDecrypt(deviceId, appId);
        if (result.error) throw new Error(result.error);
        setCurrentSubStep(3);
        dbPath = result.dbPath;
        addLog(`✓ Database decrypted: ${dbPath}`);
      }

      addLog('Parsing database...');
      const parseResult = await window.electronAPI.parseAndroid(dbPath);
      if (parseResult?.error) throw new Error(parseResult.error);

      addLog(`✓ ${parseResult.chatCount} chats, ${parseResult.messageCount} messages`);
      setCurrentSubStep(4);
      setProgress(100);

      next({ androidDbPath: dbPath, stats: { chatCount: parseResult.chatCount, messageCount: parseResult.messageCount } });
    } catch (e) {
      setError(e.message);
      addLog(`ERROR: ${e.message}`);
      setRunning(false);
    }
  }

  // Continue with manually-provided key
  async function continueWithManualKey() {
    if (!manualKeyPath) return;
    setRunning(true);
    setNeedsManualKey(false);
    setError(null);

    const { deviceId, appId } = transferData;
    addLog(`Retrying with manual key: ${manualKeyPath}`);

    const result = await window.electronAPI.norootExtract(deviceId, appId, manualKeyPath);
    if (result.error) { setError(result.error); setRunning(false); return; }
    if (result.needsKey) { setError('Key file did not work. Make sure it matches this WhatsApp installation.'); setRunning(false); return; }

    addLog('Parsing database...');
    const parseResult = await window.electronAPI.parseAndroid(result.dbPath);
    if (parseResult?.error) { setError(parseResult.error); setRunning(false); return; }

    addLog(`✓ ${parseResult.chatCount} chats, ${parseResult.messageCount} messages`);
    setProgress(100);
    next({ androidDbPath: result.dbPath, stats: { chatCount: parseResult.chatCount, messageCount: parseResult.messageCount } });
  }

  const activeMode = MODES.find(m => m.id === mode);
  const steps = STEPS[mode];
  const canStart = mode === 'apk' ? !!apkPath : mode === 'root' ? rootStatus === 'yes' : true;

  return (
    <div className="p-6 max-w-xl mx-auto">
      <h2 className="text-2xl font-bold text-white mb-1">Extract from Android</h2>
      <p className="text-slate-400 mb-4 text-sm">Choose extraction method.</p>

      {/* Mode tabs */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        {MODES.map(m => (
          <button key={m.id} onClick={() => { setMode(m.id); setError(null); setNeedsManualKey(false); }} disabled={running}
            className={`flex flex-col items-start gap-1 p-2.5 rounded-xl border transition-all text-left ${mode === m.id ? m.borderActive : 'border-slate-700 hover:border-slate-500 bg-slate-800'}`}>
            <div className="flex items-center gap-1.5 w-full">
              <m.icon className={`w-4 h-4 flex-shrink-0 ${mode === m.id ? m.iconColor : 'text-slate-500'}`} />
              <span className={`text-xs font-semibold ${mode === m.id ? m.iconColor : 'text-slate-300'}`}>{m.label}</span>
            </div>
            <span className={`text-xs px-1.5 py-0.5 rounded ${m.badgeColor}`}>{m.badge}</span>
            <span className="text-xs text-slate-500 leading-tight">{m.desc}</span>
          </button>
        ))}
      </div>

      {/* No Root info */}
      {mode === 'noroot' && (
        <div className="bg-slate-800 rounded-xl p-3 mb-4 text-xs text-slate-400 space-y-1">
          <p className="text-slate-200 font-medium">How this works (same as iCareFone):</p>
          <p>① Pulls your encrypted WhatsApp database from SD card storage via ADB (no permissions needed)</p>
          <p>② Automatically tries to extract the encryption key using <code className="text-green-400">run-as</code> and shell methods</p>
          <p>③ If auto key fails (Android 12+), you can provide the key file manually</p>
          <p className="text-slate-500">First, open WhatsApp → Settings → Chats → Chat Backup → Back Up Now</p>
        </div>
      )}

      {/* Root status */}
      {mode === 'root' && (
        <div className="bg-slate-800 rounded-xl p-3 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-semibold text-slate-200">Root Status</span>
            <button onClick={checkRoot} disabled={rootStatus === 'checking' || running}
              className="ml-auto text-xs bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-300 px-2 py-0.5 rounded">
              {rootStatus === 'checking' ? 'Checking...' : 'Re-check'}
            </button>
          </div>
          {(!rootStatus || rootStatus === 'checking') && <p className="text-xs text-slate-500 flex items-center gap-1"><Loader className="w-3 h-3 animate-spin" /> Checking...</p>}
          {rootStatus === 'yes' && <p className="text-xs text-green-400 flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" /> Root detected — ready</p>}
          {rootStatus === 'no' && (
            <div className="text-xs text-slate-400 space-y-1">
              <p className="text-amber-400">Root not detected. To root your device:</p>
              <p>1. Enable <strong className="text-slate-300">OEM Unlocking</strong> in Developer Options</p>
              <p>2. Download <strong className="text-slate-300">Magisk</strong> from github.com/topjohnwu/Magisk</p>
              <p>3. Flash via fastboot or TWRP, then re-check above</p>
            </div>
          )}
        </div>
      )}

      {/* APK picker */}
      {mode === 'apk' && (
        <div className="mb-4">
          <div className="flex gap-2 mb-1">
            <input type="text" readOnly value={apkPath || ''} placeholder="WhatsApp APK ≤ 2.19.291..."
              className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 placeholder-slate-600" />
            <button onClick={() => selectFile(setApkPath, [{ name: 'APK', extensions: ['apk'] }])} disabled={running}
              className="flex items-center gap-1 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm px-3 py-2 rounded-lg whitespace-nowrap">
              <FolderOpen className="w-4 h-4" /> Browse
            </button>
          </div>
          <p className="text-xs text-slate-500 flex gap-1"><Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> Search "WhatsApp 2.19.291 APK" on APKMirror.</p>
        </div>
      )}

      {/* Manual key prompt (appears after no-root auto-key fails) */}
      {needsManualKey && (
        <div className="bg-amber-900/20 border border-amber-700 rounded-xl p-3 mb-4">
          <p className="text-amber-300 text-sm font-semibold mb-1">⚠ Key file needed manually</p>
          <p className="text-xs text-slate-400 mb-2">
            Auto key extraction failed (common on Android 12+). The encrypted database was pulled successfully.
            Provide the key file to decrypt it. The key is at <code className="text-green-400">/data/data/com.whatsapp/files/key</code> on a rooted device.
          </p>
          <div className="flex gap-2">
            <input type="text" readOnly value={manualKeyPath || ''} placeholder="Select key file..."
              className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-300 placeholder-slate-600" />
            <button onClick={() => selectFile(setManualKeyPath, [{ name: 'Key File', extensions: ['*'] }])}
              className="flex items-center gap-1 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs px-3 py-2 rounded-lg whitespace-nowrap">
              <FolderOpen className="w-3.5 h-3.5" /> Browse
            </button>
          </div>
          {manualKeyPath && (
            <button onClick={continueWithManualKey} disabled={running}
              className="mt-2 w-full bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold py-2 rounded-lg flex items-center justify-center gap-2">
              {running ? <Loader className="animate-spin w-4 h-4" /> : <Key className="w-4 h-4" />}
              Continue with this key
            </button>
          )}
        </div>
      )}

      {/* Progress */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-slate-400 mb-1">
          <span className="truncate max-w-xs">{progressMsg || 'Ready'}</span>
          <span>{progress}%</span>
        </div>
        <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
          <div className="h-2 bg-green-500 rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
        </div>
      </div>

      {/* Sub-steps */}
      <div className="space-y-1.5 mb-3">
        {steps.map((s, i) => {
          const done = currentSubStep > i;
          const active = currentSubStep === i && running;
          return (
            <div key={i} className={`flex items-start gap-2 text-sm ${done ? 'text-green-400' : active ? 'text-white' : 'text-slate-600'}`}>
              <div className="mt-0.5 flex-shrink-0">
                {done ? <CheckCircle className="w-4 h-4" /> : active ? <Loader className="w-4 h-4 animate-spin" /> : <div className="w-4 h-4 rounded-full border border-current" />}
              </div>
              <div>
                <div className="font-medium leading-tight">{s.label}</div>
                <div className="text-xs opacity-50">{s.detail}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Log */}
      <div ref={logRef} className="bg-slate-950 rounded-lg p-3 h-24 overflow-y-auto font-mono text-xs text-slate-400 mb-3">
        {logs.map((l, i) => <div key={i}>{l}</div>)}
        {logs.length === 0 && <span className="text-slate-600">Log will appear here...</span>}
      </div>

      {error && (
        <div className="flex gap-2 bg-red-900/30 border border-red-700 rounded-lg p-3 mb-3 text-sm text-red-300">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span className="whitespace-pre-wrap">{error}</span>
        </div>
      )}

      {!needsManualKey && (
        <button onClick={runExtraction} disabled={running || !canStart}
          className="w-full bg-green-500 hover:bg-green-400 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2">
          {running ? <><Loader className="animate-spin w-4 h-4" /> Extracting...</> : <><activeMode.icon className="w-4 h-4" /> Start Extraction</>}
        </button>
      )}
    </div>
  );
}
