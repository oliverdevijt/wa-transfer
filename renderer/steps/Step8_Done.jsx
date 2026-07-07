import React from 'react';
import { CheckCircle, FolderOpen, FileText, RefreshCw } from 'lucide-react';

export default function Step8_Done({ transferData, restart }) {
  const stats = transferData.stats || {};

  async function openTemp() {
    const os = require('os');
    await window.electronAPI.openFolder(require('path').join(os.tmpdir(), 'wa-transfer'));
  }

  async function openLog() {
    await window.electronAPI.getLog();
  }

  return (
    <div className="p-8 max-w-xl mx-auto text-center">
      <div className="flex justify-center mb-4">
        <div className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center">
          <CheckCircle className="w-9 h-9 text-white" />
        </div>
      </div>
      <h2 className="text-3xl font-bold text-white mb-2">Transfer Complete!</h2>
      <p className="text-slate-400 mb-6">Your WhatsApp chats have been migrated to your iPhone backup.</p>

      {stats.chatCount && (
        <div className="bg-slate-800 rounded-xl p-4 mb-6 flex justify-center gap-8">
          <div>
            <div className="text-2xl font-bold text-green-400">{stats.chatCount}</div>
            <div className="text-xs text-slate-400">Chats</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-green-400">{stats.messageCount?.toLocaleString()}</div>
            <div className="text-xs text-slate-400">Messages</div>
          </div>
        </div>
      )}

      <div className="bg-slate-800 rounded-xl p-4 mb-6 text-left">
        <h3 className="text-sm font-semibold text-white mb-2">Next steps:</h3>
        <ol className="space-y-1.5 text-xs text-slate-400">
          <li>1. Restore your iPhone from the modified backup in iTunes</li>
          <li>2. Open WhatsApp on your iPhone after restore</li>
          <li>3. Go to <strong className="text-slate-300">Chats → Archived Chats</strong> to find restored messages</li>
          <li>4. Unarchive the chats you want to see in your main list</li>
        </ol>
      </div>

      <div className="flex gap-3 mb-4">
        <button
          onClick={() => window.electronAPI.openFolder(require('path').join(require('os').tmpdir(), 'wa-transfer'))}
          className="flex-1 flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm py-2.5 rounded-xl transition-colors"
        >
          <FolderOpen className="w-4 h-4" /> Temp Folder
        </button>
        <button
          onClick={async () => {
            const r = await window.electronAPI.getLog();
            alert((r?.lines || []).slice(-20).join('\n'));
          }}
          className="flex-1 flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm py-2.5 rounded-xl transition-colors"
        >
          <FileText className="w-4 h-4" /> View Log
        </button>
      </div>

      <button
        onClick={restart}
        className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-300 font-medium py-2.5 rounded-xl transition-colors text-sm"
      >
        <RefreshCw className="w-4 h-4" /> Transfer Other App
      </button>
    </div>
  );
}
