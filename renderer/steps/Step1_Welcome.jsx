import React from 'react';
import { MessageCircle, Usb, Bug, Music } from 'lucide-react';

export default function Step1_Welcome({ next }) {
  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="text-center mb-8">
        <div className="flex justify-center mb-4">
          <div className="w-16 h-16 bg-green-500 rounded-2xl flex items-center justify-center">
            <MessageCircle className="w-9 h-9 text-white" />
          </div>
        </div>
        <h1 className="text-3xl font-bold text-white mb-2">WA Transfer</h1>
        <p className="text-slate-400">Migrate WhatsApp chats from Android to iPhone — free &amp; open source</p>
      </div>

      <div className="bg-amber-900/30 border border-amber-700 rounded-lg p-4 mb-6 text-sm text-amber-200">
        <strong>Disclaimer:</strong> This tool interacts with WhatsApp's internal database files. Use it only on devices you own. Always keep a full backup of both phones before starting.
      </div>

      <h2 className="text-slate-300 font-semibold mb-3">Before you start, make sure you have:</h2>
      <ul className="space-y-2 mb-8">
        {[
          { icon: <Usb className="w-4 h-4" />, text: 'A USB cable to connect your Android phone' },
          { icon: <Bug className="w-4 h-4" />, text: 'USB Debugging enabled on your Android phone' },
          { icon: <Music className="w-4 h-4" />, text: 'iTunes (Win32 version, NOT Microsoft Store) installed' },
          { icon: <MessageCircle className="w-4 h-4" />, text: 'WhatsApp installed on both phones' },
        ].map((item, i) => (
          <li key={i} className="flex items-center gap-3 text-slate-300 text-sm bg-slate-800 rounded-lg px-4 py-3">
            <span className="text-green-400">{item.icon}</span>
            {item.text}
          </li>
        ))}
      </ul>

      <button
        onClick={() => next()}
        className="w-full bg-green-500 hover:bg-green-400 text-white font-semibold py-3 rounded-xl transition-colors"
      >
        Start Transfer
      </button>
    </div>
  );
}
