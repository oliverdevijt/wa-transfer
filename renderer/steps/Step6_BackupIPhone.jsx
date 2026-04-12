import React from 'react';
import { CheckCircle } from 'lucide-react';

export default function Step6_BackupIPhone({ transferData, next }) {
  return (
    <div className="p-8 max-w-xl mx-auto">
      <h2 className="text-2xl font-bold text-white mb-2">iPhone Backup Ready</h2>
      <p className="text-slate-400 mb-6">Your iTunes backup has been detected. We're ready to begin the transfer.</p>

      <div className="bg-slate-800 rounded-xl p-5 mb-6 space-y-3">
        <div className="flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-green-400" />
          <div>
            <div className="text-white text-sm font-medium">Backup ID</div>
            <div className="text-slate-400 text-xs">{transferData.iosBackupId || '—'}</div>
          </div>
        </div>
        {transferData.stats && (
          <>
            <div className="flex items-center gap-3">
              <CheckCircle className="w-5 h-5 text-green-400" />
              <div>
                <div className="text-white text-sm font-medium">Android data ready</div>
                <div className="text-slate-400 text-xs">
                  {transferData.stats.chatCount} chats · {transferData.stats.messageCount} messages
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <button
        onClick={() => next()}
        className="w-full bg-green-500 hover:bg-green-400 text-white font-semibold py-3 rounded-xl transition-colors"
      >
        Start Transfer
      </button>
    </div>
  );
}
