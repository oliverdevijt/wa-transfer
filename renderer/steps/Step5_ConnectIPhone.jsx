import React, { useState, useEffect, useRef } from 'react';
import { Smartphone, CheckCircle, Loader, AlertCircle } from 'lucide-react';

export default function Step5_ConnectIPhone({ next }) {
  const [scanning, setScanning] = useState(false);
  const [backup, setBackup] = useState(null);
  const [error, setError] = useState(null);

  async function detect() {
    setScanning(true);
    setError(null);
    try {
      const result = await window.electronAPI.detectBackup();
      if (result.error) setError(result.error);
      else setBackup(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="p-8 max-w-xl mx-auto">
      <h2 className="text-2xl font-bold text-white mb-2">Connect iPhone</h2>
      <p className="text-slate-400 mb-6">Connect your iPhone and create an unencrypted iTunes backup before proceeding.</p>

      <div className="bg-slate-800 rounded-xl p-4 mb-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-2">Setup instructions:</h3>
        <ol className="space-y-1.5 text-xs text-slate-400">
          <li>1. Connect iPhone to this PC via USB</li>
          <li>2. On your iPhone, tap <strong className="text-slate-300">Trust This Computer</strong></li>
          <li>3. Open iTunes and select your device</li>
          <li>4. Under Backups, select <strong className="text-slate-300">This Computer</strong></li>
          <li>5. Make sure <strong className="text-slate-300">"Encrypt local backup" is OFF</strong></li>
          <li>6. Click <strong className="text-slate-300">Back Up Now</strong> and wait for it to complete</li>
          <li>7. Then click <strong className="text-slate-300">Detect Backup</strong> below</li>
        </ol>
      </div>

      <div className="bg-amber-900/30 border border-amber-700 rounded-lg p-3 mb-4 text-xs text-amber-200">
        iTunes must be the <strong>Win32 version</strong> (not from the Microsoft Store). COM automation does not work with the Store version.
      </div>

      {backup && (
        <div className="bg-green-900/20 border border-green-700 rounded-xl p-4 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle className="w-5 h-5 text-green-400" />
            <span className="text-green-300 font-medium">Backup found</span>
          </div>
          <div className="text-sm text-slate-300">{backup.deviceName}</div>
          <div className="text-xs text-slate-400">ID: {backup.backupId}</div>
          {!backup.hasWhatsApp && (
            <div className="text-xs text-amber-400 mt-1">⚠ WhatsApp not found in this backup — make sure WhatsApp is installed on iPhone</div>
          )}
        </div>
      )}

      {error && (
        <div className="flex gap-2 bg-red-900/30 border border-red-700 rounded-lg p-3 mb-4 text-sm text-red-300">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={detect}
          disabled={scanning}
          className="flex-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          {scanning ? <Loader className="animate-spin w-4 h-4" /> : <Smartphone className="w-4 h-4" />}
          Detect Backup
        </button>
        <button
          onClick={() => next({ iosBackupId: backup?.backupId })}
          disabled={!backup}
          className="flex-1 bg-green-500 hover:bg-green-400 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold py-3 rounded-xl transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
