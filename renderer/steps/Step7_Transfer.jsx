import React, { useState, useEffect, useRef } from 'react';
import { Loader, AlertCircle, CheckCircle } from 'lucide-react';

export default function Step7_Transfer({ transferData, next }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentChat, setCurrentChat] = useState('');
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const logRef = useRef(null);

  useEffect(() => {
    const unsub = window.electronAPI.on('ios:merge-progress', ({ percent, currentChat: chat, done }) => {
      setProgress(percent);
      setCurrentChat(chat);
      addLog(chat);
      if (done) finalize();
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  function addLog(msg) {
    setLogs(prev => [...prev.slice(-200), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }

  async function startTransfer() {
    if (!confirmed) return;
    setRunning(true);
    setError(null);
    addLog('Starting schema merge...');

    try {
      const result = await window.electronAPI.mergeSchema(
        transferData.androidDbPath,
        transferData.iosBackupId,
        true
      );
      if (result?.error) throw new Error(result.error);

      addLog('Patching Manifest.db...');
      const patchResult = await window.electronAPI.patchManifest(transferData.iosBackupId);
      if (patchResult?.error) throw new Error(patchResult.error);

      addLog('Transfer complete!');
      next({ stats: { ...transferData.stats, transferred: true } });
    } catch (e) {
      setError(e.message);
      addLog(`ERROR: ${e.message}`);
      setRunning(false);
    }
  }

  function finalize() {
    setRunning(false);
  }

  return (
    <div className="p-8 max-w-xl mx-auto">
      <h2 className="text-2xl font-bold text-white mb-2">Transfer</h2>
      <p className="text-slate-400 mb-6">Merging Android chat data into your iPhone backup. Do not disconnect either phone.</p>

      {!running && !progress && (
        <div className="bg-amber-900/30 border border-amber-700 rounded-lg p-4 mb-4">
          <p className="text-amber-200 text-sm font-semibold mb-2">⚠ Cannot cancel mid-transfer</p>
          <p className="text-amber-300 text-xs">Once started, do not close the app until the transfer is complete. Interrupting mid-way may corrupt your iPhone backup.</p>
          <label className="flex items-center gap-2 mt-3 text-sm text-slate-300 cursor-pointer">
            <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="accent-green-500" />
            I understand and have a backup of my iPhone
          </label>
        </div>
      )}

      <div className="mb-4">
        <div className="flex justify-between text-xs text-slate-400 mb-1">
          <span className="truncate max-w-xs">{currentChat || 'Ready'}</span>
          <span>{progress}%</span>
        </div>
        <div className="h-3 bg-slate-700 rounded-full">
          <div
            className="h-3 bg-green-500 rounded-full transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div
        ref={logRef}
        className="bg-slate-950 rounded-lg p-3 h-36 overflow-y-auto font-mono text-xs text-slate-400 mb-4"
      >
        {logs.map((l, i) => <div key={i}>{l}</div>)}
        {logs.length === 0 && <span className="text-slate-600">Transfer log will appear here...</span>}
      </div>

      {error && (
        <div className="flex gap-2 bg-red-900/30 border border-red-700 rounded-lg p-3 mb-4 text-sm text-red-300">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      <button
        onClick={startTransfer}
        disabled={running || !confirmed}
        className="w-full bg-green-500 hover:bg-green-400 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
      >
        {running ? <><Loader className="animate-spin w-4 h-4" /> Transferring...</> : 'Begin Transfer'}
      </button>
    </div>
  );
}
