import React, { useState, useEffect, useRef } from 'react';
import { Smartphone, CheckCircle, Loader, AlertCircle } from 'lucide-react';

export default function Step3_ConnectAndroid({ transferData, next }) {
  const [devices, setDevices] = useState([]);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    scan();
    intervalRef.current = setInterval(scan, 2000);
    return () => clearInterval(intervalRef.current);
  }, []);

  async function scan() {
    try {
      const result = await window.electronAPI.scanDevices();
      if (result.error) {
        setError(result.error);
        setDevices([]);
      } else {
        setDevices(result.devices || []);
        setError(null);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setScanning(false);
    }
  }

  const handleNext = () => {
    if (selected) {
      clearInterval(intervalRef.current);
      next({ deviceId: selected.id });
    }
  };

  return (
    <div className="p-8 max-w-xl mx-auto">
      <h2 className="text-2xl font-bold text-white mb-2">Connect Android Phone</h2>
      <p className="text-slate-400 mb-6">Connect your Android phone via USB. USB Debugging must be enabled.</p>

      <div className="bg-slate-800 rounded-xl p-4 mb-6 min-h-32">
        {scanning && devices.length === 0 ? (
          <div className="flex items-center gap-3 text-slate-400">
            <Loader className="animate-spin w-5 h-5" />
            <span>Scanning for devices...</span>
          </div>
        ) : error ? (
          <div className="flex items-center gap-3 text-amber-400">
            <AlertCircle className="w-5 h-5" />
            <span className="text-sm">{error}</span>
          </div>
        ) : devices.length === 0 ? (
          <div className="text-center py-4">
            <Smartphone className="w-10 h-10 text-slate-600 mx-auto mb-2" />
            <p className="text-slate-400 text-sm">No devices found. Plug in your Android phone and enable USB Debugging.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {devices.map(dev => (
              <button
                key={dev.id}
                onClick={() => setSelected(dev)}
                className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all ${
                  selected?.id === dev.id
                    ? 'border-green-500 bg-green-900/20'
                    : 'border-slate-700 hover:border-slate-500'
                }`}
              >
                {selected?.id === dev.id
                  ? <CheckCircle className="w-5 h-5 text-green-400" />
                  : <Smartphone className="w-5 h-5 text-slate-400" />
                }
                <div className="text-left">
                  <div className="text-white font-medium text-sm">{dev.model}</div>
                  <div className="text-slate-400 text-xs">Android {dev.android} • {dev.id}</div>
                  <div className="text-xs mt-1">
                    {dev.hasWA && <span className="bg-green-900 text-green-400 px-2 py-0.5 rounded mr-1">WhatsApp</span>}
                    {dev.hasWAB && <span className="bg-teal-900 text-teal-400 px-2 py-0.5 rounded">WA Business</span>}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="bg-slate-800 rounded-xl p-4 mb-6">
        <h3 className="text-sm font-semibold text-slate-300 mb-3">How to enable USB Debugging:</h3>
        <ol className="space-y-1.5 text-xs text-slate-400">
          <li>1. Open <strong className="text-slate-300">Settings</strong> → <strong className="text-slate-300">About Phone</strong></li>
          <li>2. Tap <strong className="text-slate-300">Build Number</strong> 7 times to unlock Developer Options</li>
          <li>3. Go to <strong className="text-slate-300">Settings</strong> → <strong className="text-slate-300">Developer Options</strong></li>
          <li>4. Enable <strong className="text-slate-300">USB Debugging</strong></li>
          <li>5. Reconnect the USB cable and tap <strong className="text-slate-300">Allow</strong> on your phone</li>
        </ol>
      </div>

      <button
        onClick={handleNext}
        disabled={!selected}
        className="w-full bg-green-500 hover:bg-green-400 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold py-3 rounded-xl transition-colors"
      >
        Continue
      </button>
    </div>
  );
}
